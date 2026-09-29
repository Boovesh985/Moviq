"""Review sentiment + aspect analysis that keeps learning from Moviq reviews.

Bootstrap: the IMDb Large Movie Review dataset (50k reviews labelled positive/negative).
Live data: every Moviq review that has both text and a star rating is a free label
(≥ 3.5★ positive, ≤ 2★ negative), weighted higher than IMDb because it's in-domain.

Model: word 1–2-gram TF-IDF → logistic regression. Applied to whole reviews and to single
sentences; sentences that mention an aspect (acting, story, visuals…) feed per-film
"what people loved / didn't like" summaries.
"""
from __future__ import annotations

import csv
import gzip
import re
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.pipeline import Pipeline

from learning import LearnedModel, db, in_validation
from spoiler import split_sentences

IMDB = Path(__file__).parent / "data" / "external" / "imdb_reviews.csv.gz"
POSITIVE_MIN, NEGATIVE_MAX = 3.5, 2.0
LIVE_WEIGHT = 3.0
IMDB_TRAIN_SAMPLE = 25000
IMDB_VAL_SAMPLE = 3000

ASPECTS = {
    "acting": r"\b(act(ing|or|ors|ress|resses)|performances?|cast|portray\w*|played|plays)\b",
    "story": r"\b(story|stories|plot|script|writing|written|screenplay|narrative|premise|characters?|dialogue)\b",
    "visuals": r"\b(cinematograph\w*|visuals?|visually|camera(work)?|effects|cgi|vfx|animation|animated|gorgeous|stunning|colou?rs?|production design|looks (great|amazing|beautiful|stunning))\b",
    "music": r"\b(score|soundtrack|music|songs?|sound design|composer)\b",
    "pacing": r"\b(pac(e|ing|ed)|slow|drags?|dragged|too long|runtime|overlong|boring|tedious|bloated)\b",
    "ending": r"\b(ending|finale|final act|third act|last act|climax)\b",
    "humour": r"\b(funny|humou?r|jokes?|laugh\w*|hilarious|comedy)\b",
    "direction": r"\b(direction|directed|director|directing|filmmaking)\b",
}
ASPECT_RE = {k: re.compile(v, re.I) for k, v in ASPECTS.items()}


def load_imdb():
    if not IMDB.exists():
        return [], []
    with gzip.open(IMDB, "rt", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return rows, [int(r["label"]) for r in rows]


class SentimentModel(LearnedModel):
    name = "sentiment"
    primary = "accuracy"
    tolerance = 0.005

    def __init__(self):
        super().__init__()
        self._imdb = None

    def dataset(self) -> dict:
        if self._imdb is None:
            rows, _ = load_imdb()
            rng = np.random.default_rng(11)
            train = [r for r in rows if r["split"] == "train"]
            test = [r for r in rows if r["split"] == "test"]
            train = [train[i] for i in rng.permutation(len(train))[:IMDB_TRAIN_SAMPLE]]
            test = [test[i] for i in rng.permutation(len(test))[:IMDB_VAL_SAMPLE]]
            self._imdb = train, test
        imdb_train, imdb_val = self._imdb

        X = [r["text"] for r in imdb_train]
        y = [int(r["label"]) for r in imdb_train]
        w = [1.0] * len(X)
        Xv = [r["text"] for r in imdb_val]
        yv = [int(r["label"]) for r in imdb_val]

        with db() as conn, conn.cursor() as cur:
            cur.execute("""SELECT r.id, r.body, r.rating::float FROM reviews r JOIN users u ON u.id = r.user_id
                           WHERE r.body <> '' AND r.rating IS NOT NULL AND (r.rating >= %s OR r.rating <= %s)""",
                        (POSITIVE_MIN, NEGATIVE_MAX))
            live = cur.fetchall()
        lv_X, lv_y = [], []
        for rid, body, rating in live:
            label = int(rating >= POSITIVE_MIN)
            if in_validation(f"sentiment:{rid}"):
                Xv.append(body); yv.append(label); lv_X.append(body); lv_y.append(label)
            else:
                X.append(body); y.append(label); w.append(LIVE_WEIGHT)
        return {"X": X, "y": y, "w": w, "Xv": Xv, "yv": yv, "n_live": len(live), "live_val": (lv_X, lv_y)}

    def fit(self, X, y, w):
        pipe = Pipeline([
            ("tfidf", TfidfVectorizer(ngram_range=(1, 2), min_df=3, max_df=0.9, max_features=250_000, sublinear_tf=True, strip_accents="unicode")),
            ("clf", LogisticRegression(C=6.0, max_iter=1000, solver="liblinear")),
        ])
        return pipe.fit(X, y, clf__sample_weight=np.asarray(w))

    def evaluate(self, pipeline, X, y) -> dict:
        proba = pipeline.predict_proba(X)[:, 1]
        pred = (proba >= 0.5).astype(int)
        out = {"accuracy": round(float(accuracy_score(y, pred)), 3), "f1": round(float(f1_score(y, pred, zero_division=0)), 3)}
        if len(set(y)) == 2:
            out["auc"] = round(float(roc_auc_score(y, proba)), 3)
        return out

    def load_or_train(self) -> dict:
        if not self.load():
            if not IMDB.exists():
                print("[sentiment] IMDb data missing; run download_data.py. Training on live reviews only once there are enough.")
                return {}
            self.retrain("initial training")
        return self.metrics

    def analyze(self, text: str) -> dict:
        """Overall P(positive), plus the aspects each sentence talks about, scored per clause so that
        'great acting but the pacing drags' rates acting positive and pacing negative."""
        if not self.ready or not (text or "").strip():
            return {"score": None, "aspects": [], "version": self.version}
        clauses = []  # (sentence_start, sentence_end, clause_text)
        for start, end, sentence in split_sentences(text):
            for clause in CLAUSE_RE.split(sentence):
                if clause and clause.strip() and not CLAUSE_RE.fullmatch(clause):
                    clauses.append((start, end, clause.strip()))
        probs = self.pipeline.predict_proba([text] + [c[2] for c in clauses])[:, 1]
        aspects, seen = [], set()
        for (start, end, clause), p in zip(clauses, probs[1:]):
            for aspect, rx in ASPECT_RE.items():
                if rx.search(clause) and (aspect, start) not in seen:
                    seen.add((aspect, start))
                    aspects.append({"aspect": aspect, "score": round(float(p), 3), "start": start, "end": end})
        return {"score": round(float(probs[0]), 3), "aspects": aspects, "version": self.version}


CLAUSE_RE = re.compile(r"(\bbut\b|\balthough\b|\bthough\b|\bhowever\b|\byet\b|\bwhereas\b|\bwhile\b|;|—| - )", re.I)
