"""Shared machinery for models that keep learning from Moviq's database.

Every retrain follows the same rules:
  1. Build a dataset from the bootstrap data plus live labels from Postgres.
  2. Split it deterministically (by a hash of each example), so the validation set is
     stable across runs and only grows as new labels arrive.
  3. Train a candidate and score it *and* the currently deployed model on that same set.
  4. Deploy only if the candidate is at least as good (within a small tolerance).
  5. Record the run, deployed or not, in the model_versions table.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path

import joblib
import psycopg

from recommender import DB_URL

MODELS = Path(__file__).parent / "models"


def in_validation(key: str, pct: int = 20) -> bool:
    """Stable train/validation assignment: the same example always lands on the same side."""
    return int(hashlib.md5(key.encode("utf-8")).hexdigest(), 16) % 100 < pct


def db():
    return psycopg.connect(DB_URL, prepare_threshold=None, connect_timeout=10)   # safe behind a connection pooler (Neon)


class Registry:
    @staticmethod
    def record(model: str, metrics: dict, baseline: dict, n_train: int, n_live: int, deployed: bool, reason: str) -> int:
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM model_versions WHERE model = %s", (model,))
            version = cur.fetchone()[0]
            cur.execute(
                """INSERT INTO model_versions (model, version, metrics, baseline, n_train, n_live, deployed, reason)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                (model, version, json.dumps(metrics), json.dumps(baseline), n_train, n_live, deployed, reason),
            )
        return version

    @staticmethod
    def last_run(model: str):
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT trained_at FROM model_versions WHERE model = %s ORDER BY version DESC LIMIT 1", (model,))
            row = cur.fetchone()
            return row[0] if row else None

    @staticmethod
    def last_live(model: str) -> int:
        """How many live examples the most recent run of this model learned from."""
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT n_live FROM model_versions WHERE model = %s ORDER BY version DESC LIMIT 1", (model,))
            row = cur.fetchone()
            return (row[0] or 0) if row else 0

    @staticmethod
    def history(limit: int = 60):
        with db() as conn, conn.cursor() as cur:
            cur.execute("""SELECT model, version, metrics, baseline, n_train, n_live, deployed, reason, trained_at
                           FROM model_versions ORDER BY trained_at DESC LIMIT %s""", (limit,))
            cols = [c.name for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


class LearnedModel:
    """A text classifier that retrains itself from bootstrap data + live database labels."""

    name = "model"
    primary = "f1"          # metric that decides deployment
    tolerance = 0.005       # candidate may be this much worse and still ship (noise on small sets)

    def __init__(self):
        self.pipeline = None
        self.version = 0
        self.metrics: dict = {}
        self.lock = threading.Lock()
        self.path = MODELS / f"{self.name}.joblib"

    # Subclasses implement these
    def dataset(self) -> dict:  # {"X", "y", "w", "Xv", "yv", "n_live", "live_val": (Xv_live, yv_live)}
        raise NotImplementedError

    def fit(self, X, y, w):
        raise NotImplementedError

    def evaluate(self, pipeline, X, y) -> dict:
        raise NotImplementedError

    def train_candidate(self, data: dict):
        return self.fit(data["X"], data["y"], data["w"])

    def objective(self, metrics: dict) -> float:
        """The single number a candidate must match or beat to be deployed."""
        return metrics[self.primary]

    # Persistence
    def load(self) -> bool:
        if self.path.exists():
            saved = joblib.load(self.path)
            self.pipeline, self.version, self.metrics = saved["pipeline"], saved.get("version", 1), saved["metrics"]
            return True
        return False

    def save(self):
        MODELS.mkdir(exist_ok=True)
        joblib.dump({"pipeline": self.pipeline, "version": self.version, "metrics": self.metrics}, self.path)

    @property
    def ready(self) -> bool:
        return self.pipeline is not None

    def retrain(self, reason: str = "scheduled") -> dict:
        with self.lock:
            started = time.time()
            data = self.dataset()
            candidate = self.train_candidate(data)
            cand = self.evaluate(candidate, data["Xv"], data["yv"])
            live = data.get("live_val")
            if live and len(live[1]) >= 10 and len(set(live[1])) == 2:
                cand["live"] = self.evaluate(candidate, *live)
            base = self.evaluate(self.pipeline, data["Xv"], data["yv"]) if self.ready else {}
            if base and live and len(live[1]) >= 10 and len(set(live[1])) == 2:
                base["live"] = self.evaluate(self.pipeline, *live)
            for name, (Xs, ys) in data.get("subsets", {}).items():   # e.g. film-domain vs Goodreads sentences
                if len(ys) >= 10 and len(set(ys)) == 2:
                    cand[name] = self.evaluate(candidate, Xs, ys)
                    if base:
                        base[name] = self.evaluate(self.pipeline, Xs, ys)
            if base:
                base["objective"] = round(self.objective(base), 4)
            cand["objective"] = round(self.objective(cand), 4)
            deploy = not base or cand["objective"] >= base["objective"] - self.tolerance
            cand.update(examples=len(data["y"]), validation=len(data["yv"]), seconds=round(time.time() - started, 1))
            why = reason if deploy else f"{reason}; kept v{self.version} (score {base['objective']:.3f} vs {cand['objective']:.3f})"
            version = Registry.record(self.name, cand, base, len(data["y"]), data["n_live"], deploy, why)
            if deploy:
                self.pipeline, self.version, self.metrics = candidate, version, cand
                self.save()
            was = f" (was {base['objective']:.3f})" if base else ""
            print(f"[{self.name}] v{version} {'deployed' if deploy else 'rejected'}: score={cand['objective']:.3f}{was}, "
                  f"{data['n_live']} live examples")
            return {"version": version, "deployed": deploy, "metrics": cand, "baseline": base}
