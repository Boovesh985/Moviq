"""Spoiler Shield: sentence-level spoiler detection that keeps learning from Moviq users.

Model: word n-gram TF-IDF + character n-gram TF-IDF + plot-reveal cue counts → class-balanced
logistic regression. Reviews are split into sentences so only the spoiling ones get blurred.

Training data, in order of trust (all weighted; film-domain examples count more):
  1. Sentence labels from people (table spoiler_labels): readers answering "was this a spoiler?"
     after revealing a blurred sentence, readers flagging a specific sentence, and authors
     marking a flagged sentence "not a spoiler". Majority vote per sentence; more votes = more weight.
  2. Weak labels: reviews their author tagged as spoilers, or that 2+ readers flagged, contribute
     their most spoiler-like sentence as a low-weight positive.
  3. The hand-labelled seed set (data/spoiler_seed.csv), written about films.
  4. Goodreads spoilers (Wan et al. 2019): ~60k real review sentences whose authors marked them as
     spoilers or not. Book reviews, and noisy: reviewers often hid plain plot summary behind spoiler tags.
  5. data/spoiler_film_labels.csv: real sentences from TMDB film reviews, labelled by hand.

Two models are blended: a broad one trained on everything, and a film specialist trained only on
film-review sentences (seed, TMDB labels, reader labels). The blend weight and blur threshold are
chosen together on out-of-fold predictions, and deployment is judged half on film reviews and half
on Goodreads, because film reviews are what Moviq actually shows.

The Goodreads sample is balanced 50/50, but in real reviews most sentences are not spoilers, so the
blur threshold is chosen for a realistic spoiler rate (PRIOR) rather than the sample's rate. It maximises
F0.5, which values precision twice as much as recall: blurring a harmless sentence on every review costs
readers more than occasionally missing a spoiler (a threshold tuned for F1 blurred 16% of all sentences
on the site; this one blurs about 4%). Metrics are reported both raw and at that realistic rate.
"""
from __future__ import annotations

import csv
import gzip
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from sklearn.pipeline import FeatureUnion, Pipeline

from learning import LearnedModel, db, in_validation

SEED = Path(__file__).parent / "data" / "spoiler_seed.csv"
GOODREADS = Path(__file__).parent / "data" / "external" / "goodreads_spoilers.csv.gz"
FILM_LABELS = Path(__file__).parent / "data" / "spoiler_film_labels.csv"
THRESHOLD = 0.5        # default for models trained before thresholds were calibrated
PRIOR = 0.10           # assumed share of review sentences that are spoilers on a film site
WEIGHTS = {"goodreads": 1.0, "seed": 2.0, "film": 3.0, "live": 3.0, "weak": 0.5}
FILM_DOMAINS = ("seed", "film", "live")

REVEAL_CUES = [
    r"\bturns? out\b", r"\ball along\b", r"\bwas actually\b", r"\bis actually\b", r"\breveal(ed|s)?\b", r"\btwist is\b",
    r"\bin the end\b", r"\bat the end\b", r"\bfinal (scene|shot|reveal|twist)\b", r"\blast (scene|shot|minute)\b",
    r"\b(dies|died|killed|kills|murdered|shot|survives?)\b", r"\bnever (real|existed|left|woke)\b", r"\b(was|were|been)\b.{0,25}\bthe whole time\b",
    r"\b(was|is|being|as) (the|his|her|their|\w+['’]s) (killer|father|mother|brother|sister|daughter|son|twin|mole|traitor)\b", r"\bfind(s)? out\b", r"\brealis(e|ing)\b",
]
SAFE_CUES = [r"\bno spoilers?\b", r"\bwithout spoiling\b", r"\bgo in (blind|knowing)\b", r"\bavoid the trailer\b"]


class CueFeatures(BaseEstimator, TransformerMixin):
    """Counts of plot-reveal phrases and 'no spoilers' disclaimers."""

    def fit(self, X, y=None):
        return self

    def transform(self, X):
        rows = []
        for t in X:
            low = t.lower()
            reveal = sum(bool(re.search(p, low)) for p in REVEAL_CUES)
            safe = sum(bool(re.search(p, low)) for p in SAFE_CUES)
            rows.append([reveal, safe, min(len(low) / 200, 1.0)])
        return csr_matrix(np.asarray(rows, dtype=float))


def build_pipeline() -> Pipeline:
    return Pipeline([
        ("features", FeatureUnion([
            ("words", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=1, max_features=200_000, strip_accents="unicode")),
            ("chars", TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), sublinear_tf=True, min_df=2, max_features=300_000)),
            ("cues", CueFeatures()),
        ])),
        ("clf", LogisticRegression(C=4.0, class_weight="balanced", max_iter=2000)),
    ])


class Ensemble:
    """Broad model + film specialist, blended: p = (1 - a) * broad + a * film."""

    def __init__(self, broad, film, a: float, threshold: float):
        self.broad, self.film, self.a, self.threshold = broad, film, a, threshold

    def predict_proba(self, X):
        p = self.broad.predict_proba(X)
        if self.film is not None and self.a > 0:
            p = (1 - self.a) * p + self.a * self.film.predict_proba(X)
        return p

    def predict(self, X):
        return (self.predict_proba(X)[:, 1] >= self.threshold).astype(int)


class Thresholded:
    """A fitted pipeline plus the probability above which a sentence gets blurred."""

    def __init__(self, pipeline, threshold: float):
        self.pipeline, self.threshold = pipeline, threshold

    def predict_proba(self, X):
        return self.pipeline.predict_proba(X)

    def predict(self, X):
        return (self.predict_proba(X)[:, 1] >= self.threshold).astype(int)


def realistic(tpr: float, fpr: float, prior: float = PRIOR, beta: float = 1.0) -> tuple[float, float]:
    """Precision and F-beta if spoilers made up `prior` of sentences (instead of the balanced sample)."""
    precision = tpr * prior / (tpr * prior + fpr * (1 - prior)) if tpr + fpr else 0.0
    b2 = beta * beta
    f = (1 + b2) * precision * tpr / (b2 * precision + tpr) if precision + tpr else 0.0
    return precision, f


def rates(y, pred):
    y, pred = np.asarray(y), np.asarray(pred)
    pos, neg = (y == 1).sum(), (y == 0).sum()
    tpr = ((pred == 1) & (y == 1)).sum() / pos if pos else 0.0
    fpr = ((pred == 1) & (y == 0)).sum() / neg if neg else 0.0
    return float(tpr), float(fpr)


def pick_threshold(y, proba) -> float:
    """Threshold that maximises precision-weighted F0.5 at the realistic spoiler rate."""
    best_t, best_f = 0.5, -1.0
    for t in np.linspace(0.3, 0.98, 69):
        tpr, fpr = rates(y, (proba >= t).astype(int))
        f = realistic(tpr, fpr, beta=0.5)[1]
        if f > best_f:
            best_t, best_f = float(t), f
    return round(best_t, 3)


def load_film_labels():
    if not FILM_LABELS.exists():
        return []
    with open(FILM_LABELS, encoding="utf-8") as f:
        return [(r["review_id"], int(r["label"]), r["text"]) for r in csv.DictReader(f)]


def f05(y, pred) -> float:
    y, pred = np.asarray(y), np.asarray(pred)
    tp = ((pred == 1) & (y == 1)).sum()
    precision = tp / pred.sum() if pred.sum() else 0.0
    recall = tp / (y == 1).sum() if (y == 1).sum() else 0.0
    return float(1.25 * precision * recall / (0.25 * precision + recall)) if precision + recall else 0.0


def load_goodreads():
    if not GOODREADS.exists():
        return []
    with gzip.open(GOODREADS, "rt", encoding="utf-8") as f:
        return [(r["review_id"], int(r["label"]), r["text"]) for r in csv.DictReader(f)]


SENTENCE_RE = re.compile(r"[^.!?]+(?:[.!?]+|$)")


def split_sentences(text: str) -> list[tuple[int, int, str]]:
    out = []
    for m in SENTENCE_RE.finditer(text):
        chunk = m.group(0)
        stripped = chunk.strip()
        if not stripped:
            continue
        start = m.start() + (len(chunk) - len(chunk.lstrip()))
        out.append((start, start + len(stripped), stripped))
    return out


class SpoilerModel(LearnedModel):
    name = "spoiler"
    primary = "f05_realistic"
    tolerance = 0.01

    def dataset(self) -> dict:
        examples = []  # (text, label, weight, domain, split_key)
        with open(SEED, encoding="utf-8") as f:
            examples += [(r["text"], int(r["label"]), WEIGHTS["seed"], "seed", r["text"]) for r in csv.DictReader(f)]
        examples += [(text, label, WEIGHTS["film"], "film", f"tmdb:{rid}:{text}") for rid, label, text in load_film_labels()]
        # Goodreads: split by review so sentences of one review never straddle train and validation
        examples += [(text, label, WEIGHTS["goodreads"], "goodreads", f"gr:{rid}") for rid, label, text in load_goodreads()]

        with db() as conn, conn.cursor() as cur:
            # 1. Human sentence labels, majority vote
            cur.execute("SELECT sentence, label, COUNT(*) FROM spoiler_labels GROUP BY sentence, label")
            votes = defaultdict(lambda: [0, 0])
            for sentence, label, n in cur.fetchall():
                votes[sentence.strip()][label] += n
            labelled = set()
            for sentence, (no, yes) in votes.items():
                if yes == no:
                    continue  # people disagree evenly: not a useful example
                examples.append((sentence, int(yes > no), min(3.0, 1.0 + 0.5 * (abs(yes - no) - 1)) * WEIGHTS["live"], "live", sentence))
                labelled.add(sentence)

            # 2. Weak labels from review-level signals
            cur.execute("""SELECT r.body FROM reviews r LEFT JOIN spoiler_reports s ON s.review_id = r.id
                           WHERE r.body <> '' GROUP BY r.id HAVING COUNT(s.user_id) >= 2 OR bool_or(r.author_spoiler)""")
            weak = [b for (b,) in cur.fetchall()]
        if weak and self.ready:
            for body in weak:
                sentences = split_sentences(body)
                probs = self.predict_sentences([s[2] for s in sentences])
                if probs and max(probs) > 0.25:
                    text = sentences[int(np.argmax(probs))][2]
                    if text not in labelled:
                        examples.append((text, 1, WEIGHTS["weak"], "weak", text))

        X, y, w, dom, Xv, yv = [], [], [], [], [], []
        subsets = defaultdict(lambda: ([], []))
        for text, label, weight, domain, key in examples:
            # Film-domain data is scarce, so half of it is held out to make the film score meaningful.
            pct = 10 if domain == "goodreads" else 50 if domain in FILM_DOMAINS else 20
            if in_validation(f"spoiler:{key}", pct=pct):
                Xv.append(text); yv.append(label)
                group = "film" if domain in FILM_DOMAINS else domain
                subsets[group][0].append(text); subsets[group][1].append(label)
                if domain == "live":
                    subsets["live"][0].append(text); subsets["live"][1].append(label)
            else:
                X.append(text); y.append(label); w.append(weight); dom.append(domain)
        return {"X": X, "y": y, "w": w, "domains": dom, "Xv": Xv, "yv": yv, "live_val": subsets.get("live", ([], [])),
                "subsets": {k: v for k, v in subsets.items() if k in ("film", "goodreads")},
                "n_live": sum(1 for e in examples if e[3] in ("live", "weak"))}

    def objective(self, m: dict) -> float:
        """Half film reviews (what Moviq shows), half Goodreads (a big but noisy proxy)."""
        film, gr = m.get("film"), m.get("goodreads")
        if film and gr:
            return 0.5 * film["f05"] + 0.5 * gr["f05_realistic"]
        return m.get("f05_realistic", m.get("f1", 0.0))

    def train_candidate(self, data: dict):
        from sklearn.model_selection import StratifiedKFold, cross_val_predict
        X, y, w, dom = data["X"], np.asarray(data["y"]), np.asarray(data["w"]), np.asarray(data["domains"])
        # The broad model never sees film-domain sentences and the specialist never sees Goodreads, so each
        # is always scored on data it wasn't trained on when the blend is chosen.
        is_film = np.isin(dom, FILM_DOMAINS)
        calib = np.array([in_validation(f"calib:{t}", pct=10) for t in X]) & (dom == "goodreads")
        fit_broad = ~calib & ~is_film
        broad = build_pipeline().fit([t for t, f in zip(X, fit_broad) if f], y[fit_broad], clf__sample_weight=w[fit_broad])

        film_idx = np.flatnonzero(is_film)
        film_X, film_y, film_w = [X[i] for i in film_idx], y[film_idx], w[film_idx]
        film_model, film_oof = None, None
        if len(set(film_y)) == 2 and min(np.bincount(film_y)) >= 5:
            folds = min(5, int(min(np.bincount(film_y))))
            film_oof = cross_val_predict(build_pipeline(), film_X, film_y, cv=StratifiedKFold(folds, shuffle=True, random_state=3),
                                         method="predict_proba", params={"clf__sample_weight": film_w})[:, 1]
            film_model = build_pipeline().fit(film_X, film_y, clf__sample_weight=film_w)

        # Calibration data: held-back Goodreads sentences, and film sentences scored out-of-fold.
        cal_gr_X = [t for t, c in zip(X, calib) if c]
        cal_gr_y = y[calib]
        gr_broad = broad.predict_proba(cal_gr_X)[:, 1]
        gr_film = film_model.predict_proba(cal_gr_X)[:, 1] if film_model is not None else gr_broad
        film_broad = broad.predict_proba(film_X)[:, 1] if len(film_X) else np.array([])

        best = (-1.0, 0.0, THRESHOLD)
        for a in ((0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7) if film_model is not None else (0.0,)):
            p_gr = (1 - a) * gr_broad + a * gr_film
            p_film = (1 - a) * film_broad + a * film_oof if film_model is not None else film_broad
            for t in np.linspace(0.3, 0.98, 69):
                score_gr = realistic(*rates(cal_gr_y, (p_gr >= t).astype(int)), beta=0.5)[1]
                score_film = f05(film_y, (p_film >= t).astype(int)) if len(film_y) else score_gr
                score = 0.5 * score_gr + 0.5 * score_film
                if score > best[0]:
                    best = (score, a, round(float(t), 3))
        _, a, t = best
        return Ensemble(broad, film_model, a, t)

    def fit(self, X, y, w):
        # Hold back a slice of the training data to calibrate the blur threshold on.
        calib = np.array([in_validation(f"calib:{t}", pct=10) for t in X])
        Xa = [t for t, c in zip(X, calib) if not c]
        ya = [l for l, c in zip(y, calib) if not c]
        pipe = build_pipeline().fit(Xa, ya, clf__sample_weight=np.asarray(w)[~calib])
        Xc = [t for t, c in zip(X, calib) if c]
        yc = [l for l, c in zip(y, calib) if c]
        threshold = pick_threshold(yc, pipe.predict_proba(Xc)[:, 1]) if len(set(yc)) == 2 else THRESHOLD
        return Thresholded(pipe, threshold)

    def evaluate(self, model, X, y) -> dict:
        threshold = getattr(model, "threshold", THRESHOLD)
        pred = (model.predict_proba(X)[:, 1] >= threshold).astype(int)
        tpr, fpr = rates(y, pred)
        precision_real, f1_real = realistic(tpr, fpr)
        f05_real = realistic(tpr, fpr, beta=0.5)[1]
        blend = getattr(model, "a", None)
        return {
            "f1": round(float(f1_score(y, pred, zero_division=0)), 3),
            "precision": round(float(precision_score(y, pred, zero_division=0)), 3),
            "recall": round(float(recall_score(y, pred, zero_division=0)), 3),
            "accuracy": round(float(accuracy_score(y, pred)), 3),
            "f1_realistic": round(f1_real, 3),
            "f05_realistic": round(f05_real, 3),
            "f05": round(f05(y, pred), 3),
            **({"film_weight": blend} if blend is not None else {}),
            "precision_realistic": round(precision_real, 3),
            "threshold": threshold,
            "n": len(y),
        }

    def load_or_train(self) -> dict:
        if not self.load():
            self.retrain("initial training")
        return self.metrics

    def predict_sentences(self, texts: list[str]) -> list[float]:
        if not texts or not self.ready:
            return [0.0] * len(texts)
        return [float(p) for p in self.pipeline.predict_proba(texts)[:, 1]]

    def analyze(self, text: str) -> dict:
        sentences = split_sentences(text or "")
        probs = self.predict_sentences([s[2] for s in sentences])
        threshold = getattr(self.pipeline, "threshold", THRESHOLD)
        spans = [{"start": s, "end": e, "score": round(p, 3), "spoiler": p >= threshold} for (s, e, _), p in zip(sentences, probs)]
        top = max(probs, default=0.0)
        return {"is_spoiler": top >= threshold, "score": round(top, 3), "threshold": threshold, "sentences": spans, "version": self.version}
