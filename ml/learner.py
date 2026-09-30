"""The background loop that keeps Moviq's models learning from the live database.

Every LEARN_INTERVAL seconds it:
  1. Scores reviews that are new, edited, or were scored by an older model version
     (spoiler spans, sentiment, aspects), applying human spoiler votes as overrides.
  2. Retrains the Spoiler Shield once enough new sentence labels have arrived.
  3. Retrains the sentiment model once enough new rated reviews have arrived.
  4. Re-learns the recommender's blend weights once enough new ratings have arrived (or daily).
Each retrain goes through the deployment gate in learning.py / tune_recommender().
"""
from __future__ import annotations

import json
import math
import os
import threading
import time
import traceback
from collections import defaultdict
from datetime import datetime, timezone

from learning import Registry, db
from recommender import DEFAULT_WEIGHTS, Recommender
from sentiment import IMDB, NEGATIVE_MAX, POSITIVE_MIN, SentimentModel
from spoiler import GOODREADS, THRESHOLD, SpoilerModel

INTERVAL = int(os.environ.get("LEARN_INTERVAL", 120))
# 0 on small hosts (a free instance has a tenth of a CPU): reviews are still scored, but models only
# retrain when an admin asks for it on the "How Moviq learns" page.
AUTO_RETRAIN = os.environ.get("AUTO_RETRAIN", "1") != "0"
SPOILER_MIN_NEW = int(os.environ.get("SPOILER_MIN_NEW", 5))
SENTIMENT_MIN_NEW = int(os.environ.get("SENTIMENT_MIN_NEW", 20))
RECOMMENDER_MIN_NEW = int(os.environ.get("RECOMMENDER_MIN_NEW", 25))
RECOMMENDER_MAX_AGE_H = 24
SCORING_SCHEMA = 2   # bump when the meaning of stored scores changes, so every review is re-scored


class Learner:
    def __init__(self, rec: Recommender, spoiler: SpoilerModel, sentiment: SentimentModel):
        self.rec, self.spoiler, self.sentiment = rec, spoiler, sentiment
        self.busy = threading.Lock()
        self.last_step = None
        self.last_error = None
        self.activity = "starting"

    # ── review scoring ───────────────────────────────────────────────────
    def human_votes(self, review_ids: list[int]) -> dict:
        """review_id -> {sentence: +votes for spoiler / -votes for not a spoiler}."""
        if not review_ids:
            return {}
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT review_id, sentence, SUM(CASE WHEN label = 1 THEN 1 ELSE -1 END) FROM spoiler_labels "
                        "WHERE review_id = ANY(%s) GROUP BY review_id, sentence", (review_ids,))
            out = defaultdict(dict)
            for rid, sentence, net in cur.fetchall():
                out[rid][sentence.strip()] = net
            return out

    @staticmethod
    def fuse(p_text: float, rating: float | None, strength: float = 0.8) -> float:
        """Combines the model's reading of some text with the star rating the author gave.
        The rating is the ground truth for the review as a whole; for a single clause it's a prior
        (a 5★ review that says 'the pacing drags' still reads negative on pacing, just less so)."""
        if rating is None:
            return p_text
        logit = lambda p: math.log(p / (1 - p))
        p_text = min(max(p_text, 1e-3), 1 - 1e-3)
        p_rating = min(max((rating - 0.5) / 4.5, 0.05), 0.95)
        return 1 / (1 + math.exp(-(logit(p_text) + strength * logit(p_rating))))

    def analyze(self, body: str, votes: dict | None = None, rating: float | None = None) -> dict:
        sp = self.spoiler.analyze(body)
        for s in sp["sentences"]:
            net = (votes or {}).get(body[s["start"]:s["end"]].strip(), 0)
            if net:                        # people have the final say on their own site
                s["spoiler"] = net > 0
                s["human"] = True
        flagged = [s for s in sp["sentences"] if s["spoiler"]]
        sp["score"] = max((s["score"] if not s.get("human") else 1.0 for s in flagged), default=min(sp["score"], sp.get("threshold", THRESHOLD) - 0.01))
        se = self.sentiment.analyze(body)
        se["model_score"] = se["score"]
        if se["score"] is not None and rating is not None:
            se["score"] = round(min(max((rating - 0.5) / 4.5, 0.0), 1.0), 3)   # stars are the truth for the whole review
            for a in se["aspects"]:
                a["score"] = round(self.fuse(a["score"], rating), 3)
        return {"spoiler": sp, "sentiment": se}

    def save_scores(self, cur, review_id: int, result: dict, body: str):
        """Writes scores for the text they were computed from; if the review was edited meanwhile, nothing is
        written (its offsets would point into the old text) and the edit's own rescore wins."""
        sp, se = result["spoiler"], result["sentiment"]
        spans = [{"start": s["start"], "end": s["end"], "score": s["score"], **({"human": True} if s.get("human") else {})}
                 for s in sp["sentences"] if s["spoiler"]]
        cur.execute(
            """UPDATE reviews SET spoiler_score = %s, spoiler_sentences = %s, sentiment = %s, sentiment_model = %s, aspects = %s,
                                 scored_by = %s WHERE id = %s AND body = %s""",
            (max(sp["score"], 0.0001), json.dumps(spans), se["score"], se.get("model_score"), json.dumps(se["aspects"]),
             json.dumps({"spoiler": self.spoiler.version, "sentiment": self.sentiment.version, "schema": SCORING_SCHEMA}), review_id, body),
        )

    def rescore_review(self, review_id: int) -> dict | None:
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT body, rating::float FROM reviews WHERE id = %s", (review_id,))
            row = cur.fetchone()
            if not row or not row[0]:
                return None
            result = self.analyze(row[0], self.human_votes([review_id]).get(review_id), row[1])
            self.save_scores(cur, review_id, result, row[0])
            return result

    def score_stale_reviews(self, batch: int = 300) -> int:
        """Scores reviews never scored, or scored by an older model version."""
        total = 0
        while True:
            with db() as conn, conn.cursor() as cur:
                cur.execute(
                    """SELECT id, body, rating::float FROM reviews WHERE body <> '' AND (
                         COALESCE((scored_by->>'spoiler')::int, 0) <> %s OR COALESCE((scored_by->>'sentiment')::int, 0) <> %s
                         OR COALESCE((scored_by->>'schema')::int, 0) <> %s)
                       ORDER BY id LIMIT %s""", (self.spoiler.version, self.sentiment.version, SCORING_SCHEMA, batch))
                rows = cur.fetchall()
                if not rows:
                    return total
                votes = self.human_votes([r[0] for r in rows])
                for rid, body, rating in rows:
                    self.save_scores(cur, rid, self.analyze(body, votes.get(rid), rating), body)
                total += len(rows)
            if len(rows) < batch:
                return total

    # ── retraining triggers ──────────────────────────────────────────────
    @staticmethod
    def count_since(sql: str, since) -> int:
        with db() as conn, conn.cursor() as cur:
            cur.execute(sql, (since or datetime(1970, 1, 1, tzinfo=timezone.utc),))
            return cur.fetchone()[0]

    @staticmethod
    def count(sql: str) -> int:
        with db() as conn, conn.cursor() as cur:
            cur.execute(sql)
            return cur.fetchone()[0]

    def pending(self) -> dict:
        """New examples since each model last trained. Counted as 'how many exist now' minus 'how many the
        last run used', so imported data with old timestamps (TMDB, Letterboxd) still counts as new."""
        return {
            "spoiler": self.count_since("SELECT COUNT(*) FROM spoiler_labels WHERE created_at > %s", Registry.last_run("spoiler")),
            "sentiment": max(0, self.count(f"""SELECT COUNT(*) FROM reviews WHERE body <> '' AND rating IS NOT NULL
                                              AND (rating >= {POSITIVE_MIN} OR rating <= {NEGATIVE_MAX})""") - Registry.last_live("sentiment")),
            "recommender": max(0, self.count("SELECT COUNT(*) FROM reviews WHERE rating IS NOT NULL") - Registry.last_live("recommender")),
        }

    def tune_recommender(self, reason: str) -> dict:
        result = self.rec.tune()
        tuned, current = result["test"]["tuned"], result["test"]["current"]
        deploy = self.rec.weights_version == 0 or tuned["ndcg@10"] >= current["ndcg@10"] - 0.001
        metrics = {**tuned, "weights": result["weights"], "signals": {k: result["test"][k] for k in ("content", "collab", "latent", "crowd")},
                   "by_source": result["test"].get("by_source", {}),
                   "people": result["people"], "hidden_ratings": result["hidden_ratings"]}
        why = reason if deploy else f"{reason}; kept current weights (nDCG {current['ndcg@10']:.4f} vs {tuned['ndcg@10']:.4f})"
        total = self.count("SELECT COUNT(*) FROM reviews WHERE rating IS NOT NULL")
        version = Registry.record("recommender", metrics, {**current, "weights": self.rec.weights}, result["hidden_ratings"],
                                  total, deploy, why)
        if deploy:
            self.rec.weights, self.rec.weights_version = result["weights"], version
        print(f"[recommender] v{version} {'deployed' if deploy else 'rejected'}: nDCG@10 {tuned['ndcg@10']:.4f} "
              f"(current {current['ndcg@10']:.4f}), weights {result['weights']}")
        return {"version": version, "deployed": deploy, "metrics": metrics}

    def load_recommender_weights(self):
        with db() as conn, conn.cursor() as cur:
            cur.execute("""SELECT version, metrics->'weights' FROM model_versions WHERE model = 'recommender' AND deployed
                           ORDER BY version DESC LIMIT 1""")
            row = cur.fetchone()
        if row:
            self.rec.weights_version, self.rec.weights = row[0], {**DEFAULT_WEIGHTS, **row[1]}

    @staticmethod
    def trainable(model: str) -> bool:
        """The text models retrain on their base dataset plus live data. A deployment that ships only the
        trained models (the public demo doesn't redistribute IMDb or Goodreads) keeps them as they are."""
        return {"spoiler": GOODREADS, "sentiment": IMDB}.get(model, None) is None or \
            {"spoiler": GOODREADS, "sentiment": IMDB}[model].exists()

    def run(self, model: str, reason: str) -> dict:
        with self.busy:
            self.activity = f"training {model}"
            try:
                if model == "spoiler":
                    return self.spoiler.retrain(reason)
                if model == "sentiment":
                    return self.sentiment.retrain(reason)
                if model == "recommender":
                    self.rec.ensure_fresh()
                    return self.tune_recommender(reason)
                raise ValueError(model)
            finally:
                self.activity = "idle"

    def step(self):
        if not AUTO_RETRAIN:
            with self.busy:
                self.activity = "scoring reviews"
                self.score_stale_reviews()
                self.activity = "idle"
            self.last_step = datetime.now(timezone.utc)
            return
        pending = self.pending()
        if not self.sentiment.ready and self.trainable("sentiment"):
            self.run("sentiment", "initial training")
        if pending["spoiler"] >= SPOILER_MIN_NEW and self.trainable("spoiler"):
            self.run("spoiler", f"{pending['spoiler']} new spoiler labels")
        if pending["sentiment"] >= SENTIMENT_MIN_NEW and self.trainable("sentiment"):
            self.run("sentiment", f"{pending['sentiment']} new rated reviews")
        last = Registry.last_run("recommender")
        stale = last is None or (datetime.now(timezone.utc) - last).total_seconds() > RECOMMENDER_MAX_AGE_H * 3600
        if pending["recommender"] >= RECOMMENDER_MIN_NEW or stale:
            self.run("recommender", f"{pending['recommender']} new ratings" if not stale else "daily refresh")
        with self.busy:
            self.activity = "scoring reviews"
            n = self.score_stale_reviews()
            self.activity = "idle"
        if n:
            print(f"[learner] scored {n} reviews")
        self.last_step = datetime.now(timezone.utc)

    def loop(self):
        while True:
            try:
                self.step()
                self.last_error = None
            except Exception as e:  # keep learning even if one step fails
                self.last_error = f"{type(e).__name__}: {e}"
                traceback.print_exc()
            time.sleep(INTERVAL)

    def start(self):
        self.load_recommender_weights()
        threading.Thread(target=self.loop, daemon=True, name="learner").start()

    def status(self) -> dict:
        return {
            "activity": self.activity, "interval_seconds": INTERVAL, "last_step": self.last_step, "last_error": self.last_error,
            "pending": self.pending(),
            "thresholds": {"spoiler": SPOILER_MIN_NEW, "sentiment": SENTIMENT_MIN_NEW, "recommender": RECOMMENDER_MIN_NEW},
            "trainable": {m: self.trainable(m) for m in ("spoiler", "sentiment", "recommender")},
            "auto_retrain": AUTO_RETRAIN,
        }
