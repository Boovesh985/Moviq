"""Hybrid recommender for Moviq.

Four signals, blended per user:
  content  – TF-IDF over genres, moods, director, cast and synopsis (item-item cosine)
  collab   – item-item collaborative filtering on mean-centred ratings, shrunk by co-rating count
  latent   – PureSVD: the user's centred ratings projected through 48 latent item factors
  crowd    – Bayesian-average community rating + this week's watch activity

Reviews with text but no stars count too: the sentiment model turns them into an implied rating.

The blend weights are learned, not hand-set. tune() replays history: for every person with
enough ratings it hides their most recent ones, rebuilds the model on the rest, and searches
for the weights that best rank the films they went on to love. Weights are tuned on half the
people and reported on the other half, and only replace the live weights if they do better.
New users lean on the crowd until they've rated enough for the personal signals to kick in.
"""
from __future__ import annotations

import functools
import hashlib
import inspect
import os
import threading
import time
from dataclasses import dataclass, field

import numpy as np
import psycopg
from scipy.sparse.linalg import svds
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.preprocessing import normalize

DB_URL = os.environ.get("DATABASE_URL", "postgres://moviq:moviq@localhost:5544/moviq")
BAYES_C = 5          # pseudo-ratings pulling small samples toward the global mean
SHRINK = 5           # co-rating shrinkage for collaborative similarities
FACTORS = 48         # latent dimensions for PureSVD
FAMILY_SAFE = {"G", "PG", "PG-13"}
SIGNALS = ("content", "collab", "latent", "crowd")
DEFAULT_WEIGHTS = {"content": 0.35, "collab": 0.15, "latent": 0.35, "crowd": 0.15}


def zscore(v: np.ndarray, mask: np.ndarray | None = None) -> np.ndarray:
    ref = v[mask] if mask is not None and mask.any() else v
    sd = ref.std()
    return (v - ref.mean()) / sd if sd > 1e-9 else np.zeros_like(v)


def sigmoid(x):
    return 1 / (1 + np.exp(-x))


@dataclass
class Profile:
    weights: np.ndarray           # per-item preference weight (content signal)
    centred: dict[int, float]     # item index -> centred rating (collab + latent signals)
    seen: np.ndarray              # bool mask of items already watched/rated
    n_ratings: int
    ratings: dict[int, float] = field(default_factory=dict)
    liked: set[int] = field(default_factory=set)


def serving(fn):
    """Public entry point: refresh the model if needed, then read it under the lock so a refit
    can't swap it out halfway through a request."""
    sig = inspect.signature(fn)

    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        bound = sig.bind(self, *args, **kwargs).arguments
        users = bound.get("user_ids") or ([bound["user_id"]] if "user_id" in bound else [])
        self.ensure_fresh(users)
        with self.lock:
            return fn(self, *args, **kwargs)
    return wrapper


class Recommender:
    # Fitted state that fit() swaps in as a whole; everything else (locks, learned weights) stays put.
    KEEP = ("lock", "refit_lock", "weights", "weights_version", "dirty_at", "changed_users")

    def __init__(self):
        self.lock = threading.RLock()        # held while serving a request or swapping in a refit
        self.refit_lock = threading.Lock()   # one refit at a time
        self.fitted_at = 0.0
        self.dirty_at = time.time()
        self.changed_users = set()           # people whose own data changed since the last fit
        self.weights = dict(DEFAULT_WEIGHTS)
        self.weights_version = 0

    # ── data ──────────────────────────────────────────────────────────────
    def mark_dirty(self, user_id: int | None = None):
        self.dirty_at = time.time()
        if user_id is not None:
            self.changed_users.add(user_id)

    def fit(self):
        """Builds a fresh model to the side (1-3 s), then swaps it in at once."""
        started = time.time()
        covered = set(self.changed_users)
        fresh = Recommender()
        fresh.build(*self.load_raw())
        state = {k: v for k, v in fresh.__dict__.items() if k not in self.KEEP}
        with self.lock:
            self.__dict__.update(state)
            self.fitted_at = started   # changes that arrived during the build still count as new
            self.changed_users -= covered

    @staticmethod
    def load_raw():
        with psycopg.connect(DB_URL, prepare_threshold=None) as conn, conn.cursor() as cur:
            cur.execute("""SELECT id, title, year, runtime, genres, moods, director, cast_names, certification,
                                  overview, stream_url IS NOT NULL, providers, popularity FROM movies ORDER BY id""")
            movies = cur.fetchall()
            # Editorial demo reviews are for show; they don't train the recommender.
            cur.execute("""SELECT r.user_id, r.movie_id, r.rating::float, r.liked, EXTRACT(EPOCH FROM r.created_at)::bigint, r.sentiment
                           FROM reviews r JOIN users u ON u.id = r.user_id WHERE u.source <> 'editorial'""")
            reviews = cur.fetchall()
            # "Trending" means watched on Moviq this week, not imported history (MovieLens, TMDB reviews).
            cur.execute("""SELECT w.user_id, w.movie_id, w.completed, w.last_watched_at > NOW() - INTERVAL '7 days' AND u.source = 'moviq'
                           FROM watch_history w JOIN users u ON u.id = w.user_id""")
            watches = cur.fetchall()
            cur.execute("SELECT user_id, movie_id FROM watchlist")
            watchlist = cur.fetchall()
        return movies, reviews, watches, watchlist

    def build(self, movies, reviews, watches, watchlist):
        """Fits every signal from raw rows (tune() calls this with history held out)."""
        self.ids = np.array([m[0] for m in movies])
        self.index = {mid: i for i, mid in enumerate(self.ids)}
        self.meta = [
            dict(id=m[0], title=m[1], year=m[2], runtime=m[3] or 0, genres=m[4] or [], moods=m[5] or [], director=m[6] or "",
                 cast=m[7] or [], cert=m[8] or "NR", free=bool(m[10]), providers=m[11] or [], popularity=m[12] or 0)
            for m in movies
        ]
        n = len(self.ids)

        # Content similarity. Tags are repeated so they outweigh free-text synopsis words.
        def doc(m, row):
            tag = lambda xs, k: " ".join((x.replace(" ", "_").replace("-", "_") + " ") * k for x in xs)
            return " ".join([tag(m["genres"], 3), tag(m["moods"], 2), tag([m["director"]], 2), tag(m["cast"], 1), row[9] or ""])
        tfidf = TfidfVectorizer(stop_words="english", sublinear_tf=True, token_pattern=r"(?u)\b[\w']+\b")
        X = tfidf.fit_transform([doc(m, row) for m, row in zip(self.meta, movies)])
        self.content_sim = (X @ X.T).toarray().astype(np.float32)
        np.fill_diagonal(self.content_sim, 0)

        # Ratings matrix; text-only reviews get an implied rating from their sentiment
        users = sorted({r[0] for r in reviews} | {w[0] for w in watches} | {w[0] for w in watchlist})
        self.user_index = {u: i for i, u in enumerate(users)}
        R = np.zeros((len(users), n), dtype=np.float32)
        M = np.zeros((len(users), n), dtype=bool)
        L = np.zeros((len(users), n), dtype=bool)
        self.implied = {}
        for row in reviews:
            u, mid, rating, liked = row[:4]
            sentiment = row[5] if len(row) > 5 else None
            if mid not in self.index:
                continue
            i, j = self.user_index[u], self.index[mid]
            if rating is not None:
                R[i, j], M[i, j] = rating, True
            elif sentiment is not None:
                self.implied[(u, j)] = 0.5 + 4.5 * sentiment
            if liked:
                L[i, j] = True
        self.R, self.M, self.L = R, M, L
        self.global_mean = float(R[M].mean()) if M.any() else 3.5
        counts = M.sum(1)
        self.user_mean = np.where(counts > 0, (R.sum(1) + 3 * self.global_mean) / (counts + 3), self.global_mean)
        C = np.where(M, R - self.user_mean[:, None], 0.0).astype(np.float32)

        # Item-item collaborative similarity with co-rating shrinkage
        Cn = normalize(C.T)
        co = M.T.astype(np.float32) @ M.astype(np.float32)
        self.cf_sim = ((Cn @ Cn.T) * (co / (co + SHRINK))).astype(np.float32)
        np.fill_diagonal(self.cf_sim, 0)

        # PureSVD item factors (Cremonesi et al. 2010): scores = r̃ · V · Vᵀ
        k = min(FACTORS, min(C.shape) - 1)
        if k >= 2 and np.abs(C).sum() > 0:
            _, _, vt = svds(C.astype(np.float64), k=k)
            self.V = vt.T.astype(np.float32)
        else:
            self.V = np.zeros((n, 1), dtype=np.float32)

        # Crowd signal
        n_i = M.sum(0)
        mean_i = np.where(n_i > 0, R.sum(0) / np.maximum(n_i, 1), self.global_mean)
        self.bayes = (n_i * mean_i + BAYES_C * self.global_mean) / (n_i + BAYES_C)
        self.n_ratings_item = n_i
        self.trending = np.zeros(n)
        self.watched = np.zeros((len(users), n), dtype=bool)
        for u, mid, completed, recent in watches:
            if mid in self.index:
                j = self.index[mid]
                if recent:
                    self.trending[j] += 1
                self.watched[self.user_index[u], j] = True
        self.crowd = zscore(self.bayes) + 0.6 * zscore(np.log1p(self.trending)) + 0.3 * zscore(np.log1p(n_i))

        self.watchlist = {}
        for u, mid in watchlist:
            if mid in self.index:
                self.watchlist.setdefault(u, set()).add(self.index[mid])

        self.fitted_at = time.time()

    def ensure_fresh(self, user_ids=()):
        """Serve the current model and refit in the background when data has changed, so requests never
        wait on a refit. The exception is the person who just changed their own data (rated a film,
        finished onboarding): their next request waits for a fit, so it reflects what they just did."""
        if self.fitted_at == 0 or self.changed_users.intersection(user_ids):
            with self.refit_lock:   # waits for a refit already in flight, then checks again
                if self.fitted_at == 0 or self.changed_users.intersection(user_ids):
                    self.fit()
            return
        stale = time.time() - self.fitted_at
        dirty = self.dirty_at > self.fitted_at
        if ((dirty and stale > 3) or stale > 300) and not self.refit_lock.locked():
            threading.Thread(target=self._refit_in_background, daemon=True).start()

    def _refit_in_background(self):
        if not self.refit_lock.acquire(blocking=False):
            return
        try:
            self.fit()
        except Exception as e:  # keep serving the previous model
            print(f"[recommender] background refit failed: {e}")
        finally:
            self.refit_lock.release()

    # ── scoring ───────────────────────────────────────────────────────────
    def profile(self, user_id: int) -> Profile:
        n = len(self.ids)
        w = np.zeros(n)
        seen = np.zeros(n, dtype=bool)
        centred, ratings, liked = {}, {}, set()
        ui = self.user_index.get(user_id)
        if ui is not None:
            mu = self.user_mean[ui]
            for j in np.flatnonzero(self.M[ui]):
                r = float(self.R[ui, j])
                ratings[j] = r
                centred[j] = r - mu
                w[j] = (r - mu) / 2
            for j in np.flatnonzero(self.L[ui]):
                w[j] += 0.35
                liked.add(j)
            seen = self.M[ui] | self.watched[ui]
            for j in np.flatnonzero(self.watched[ui] & ~self.M[ui]):
                implied = self.implied.get((user_id, j))
                if implied is not None:          # wrote a review but gave no stars
                    centred[j] = 0.6 * (implied - mu)
                    w[j] += (implied - mu) / 2
                else:
                    w[j] += 0.15                 # finished without rating: mild positive
        for j in self.watchlist.get(user_id, ()):
            w[j] += 0.2
        n_ratings = sum(1 for j in centred if j in ratings)
        return Profile(w, centred, seen, n_ratings, ratings, liked)

    def components(self, p: Profile) -> dict:
        n = len(self.ids)
        out = {"content": np.zeros(n), "collab": np.zeros(n), "latent": np.zeros(n), "crowd": self.crowd}
        active = np.flatnonzero(p.weights)
        if len(active):
            S = self.content_sim[:, active]
            out["content"] = S @ p.weights[active] / (np.abs(S).sum(1) + 0.5)
        if p.centred:
            js = np.fromiter(p.centred.keys(), dtype=int)
            r = np.fromiter(p.centred.values(), dtype=float)
            S = self.cf_sim[:, js]
            out["collab"] = S @ r / (np.abs(S).sum(1) + 1.0)
            out["latent"] = self.V @ (self.V[js].T @ r)
        return out

    def effective_weights(self, p: Profile, weights: dict | None = None) -> dict:
        """Learned weights for established users; personal signals fade in as a new user rates films."""
        w = weights or self.weights
        know = min(1.0, p.n_ratings / 15)
        signals = min(1.0, len(np.flatnonzero(p.weights)) / 5)
        personal = (w["collab"] + w["latent"]) * (1 - know)
        return {"content": w["content"], "collab": w["collab"] * know, "latent": w["latent"] * know,
                "crowd": w["crowd"] + 0.5 * personal + 0.4 * (1 - signals)}

    def blend(self, p: Profile, weights: dict | None = None, comps: dict | None = None):
        comps = comps or self.components(p)
        mask = ~p.seen
        w = self.effective_weights(p, weights)
        parts = {k: w[k] * zscore(comps[k], mask) for k in SIGNALS}
        return sum(parts.values()), parts

    @staticmethod
    def match_pct(final: np.ndarray) -> np.ndarray:
        return np.clip(np.round(50 + 48 * sigmoid(0.9 * final - 0.3)), 50, 98).astype(int)

    def reasons(self, j: int, p: Profile, parts: dict) -> list[str]:
        c, cf, lat, pop = (parts[k][j] for k in SIGNALS)
        out = []
        loved = [k for k in np.flatnonzero(p.weights > 0.2)]
        if max(cf, lat) >= max(c, pop) and p.centred:
            ks = [k for k, v in p.centred.items() if v > 0.4]
            if ks:
                k = max(ks, key=lambda k: self.cf_sim[j, k] * p.centred[k])
                if self.cf_sim[j, k] > 0.05:
                    out.append(f"People who loved {self.meta[k]['title']} rated this highly")
            if not out and lat > 0:
                out.append("Fits the pattern of films you rate highly")
        if loved and (c >= pop or not out):
            k = max(loved, key=lambda k: self.content_sim[j, k] * p.weights[k])
            if self.content_sim[j, k] > 0.08:
                out.append(f"Because you liked {self.meta[k]['title']}")
        if not out or pop > max(c, cf, lat):
            if self.trending[j] >= np.percentile(self.trending, 85) and self.trending[j] > 0:
                out.append("Trending on Moviq this week")
            elif self.n_ratings_item[j] >= 5:
                out.append(f"Rated {self.bayes[j]:.1f}★ by {int(self.n_ratings_item[j])} members")
        if not out:
            out.append(f"Popular in {self.meta[j]['genres'][0] if self.meta[j]['genres'] else 'Moviq'}")
        return list(dict.fromkeys(out))[:2]

    # ── learning the blend ────────────────────────────────────────────────
    @staticmethod
    def temporal_split(reviews, holdout=0.2, min_ratings=10):
        """Hide each person's most recent 20% of ratings (what they watched *next*)."""
        by_user = {}
        for r in reviews:
            if r[2] is not None:
                by_user.setdefault(r[0], []).append(r)
        hidden = {}
        for u, rs in by_user.items():
            if len(rs) < min_ratings:
                continue
            rs.sort(key=lambda r: r[4] or 0)
            cut = rs[-max(1, int(len(rs) * holdout)):]
            hidden[u] = {r[1]: r[2] for r in cut}
        train = [r for r in reviews if r[1] not in hidden.get(r[0], {})]
        return train, hidden

    def ranking_metrics(self, users: dict, weights_or_signal, k: int = 10, cache=None) -> dict:
        """recall@k and nDCG@k over held-out films rated ≥ 4★."""
        recalls, ndcgs = [], []
        for u, held in users.items():
            relevant = {mid for mid, r in held.items() if r >= 4}
            if not relevant or u not in self.user_index:
                continue
            p, comps = cache[u] if cache else (self.profile(u), None)
            comps = comps or self.components(p)
            if isinstance(weights_or_signal, str):
                score = zscore(comps[weights_or_signal], ~p.seen)
            else:
                score, _ = self.blend(p, weights_or_signal, comps)
            score = np.where(p.seen, -np.inf, score)
            top = [int(self.ids[j]) for j in np.argpartition(-score, k)[:k]]
            top.sort(key=lambda mid: -score[self.index[mid]])
            hits = [mid in relevant for mid in top]
            recalls.append(sum(hits) / min(k, len(relevant)))
            dcg = sum(h / np.log2(i + 2) for i, h in enumerate(hits))
            ndcgs.append(dcg / sum(1 / np.log2(i + 2) for i in range(min(k, len(relevant)))))
        return {"recall@10": round(float(np.mean(recalls)), 4) if recalls else 0.0,
                "ndcg@10": round(float(np.mean(ndcgs)), 4) if ndcgs else 0.0, "users": len(recalls)}

    def tune(self, raw=None) -> dict:
        """Learns blend weights from history; returns tuning + test metrics (does not deploy)."""
        movies, reviews, watches, watchlist = raw or self.load_raw()
        train, hidden = self.temporal_split(reviews)
        held_pairs = {(u, m) for u, h in hidden.items() for m in h}
        train_w = [w for w in watches if (w[0], w[1]) not in held_pairs]
        sim = Recommender()
        sim.build(movies, train, train_w, watchlist)
        half = lambda u: int(hashlib.md5(str(u).encode()).hexdigest(), 16) % 2
        tune_users = {u: h for u, h in hidden.items() if half(u) == 0}
        test_users = {u: h for u, h in hidden.items() if half(u) == 1}
        cache = {}
        for u in hidden:
            if u in sim.user_index:
                p = sim.profile(u)
                cache[u] = (p, sim.components(p))

        best = dict(self.weights)
        best_score = sim.ranking_metrics(tune_users, best, cache=cache)["ndcg@10"]
        step = 0.1
        while step >= 0.025:      # coordinate ascent over the four weights
            improved = False
            for key in SIGNALS:
                for delta in (step, -step):
                    trial = dict(best)
                    trial[key] = max(0.0, trial[key] + delta)
                    total = sum(trial.values()) or 1
                    trial = {k: v / total for k, v in trial.items()}
                    score = sim.ranking_metrics(tune_users, trial, cache=cache)["ndcg@10"]
                    if score > best_score + 1e-4:
                        best, best_score, improved = trial, score, True
            if not improved:
                step /= 2
        best = {k: round(v, 3) for k, v in best.items()}
        report = {name: sim.ranking_metrics(test_users, name, cache=cache) for name in SIGNALS}
        report["current"] = sim.ranking_metrics(test_users, self.weights, cache=cache)
        report["tuned"] = sim.ranking_metrics(test_users, best, cache=cache)
        # The same test, split by where people came from: MovieLens raters vs Moviq's own members.
        with psycopg.connect(DB_URL, prepare_threshold=None) as conn, conn.cursor() as cur:
            cur.execute("SELECT id, source FROM users WHERE id = ANY(%s)", (list(test_users),))
            source = dict(cur.fetchall())
        report["by_source"] = {}
        for src in sorted(set(source.values())):
            group = {u: h for u, h in test_users.items() if source.get(u) == src}
            report["by_source"][src] = {
                "tuned": sim.ranking_metrics(group, best, cache=cache),
                "popularity": sim.ranking_metrics(group, "crowd", cache=cache),
            }
        return {"weights": best, "tune_ndcg": round(best_score, 4), "test": report,
                "people": len(hidden), "hidden_ratings": sum(len(h) for h in hidden.values())}

    # ── public API ────────────────────────────────────────────────────────
    @serving
    def recommend(self, user_id: int, limit=20, exclude_ids=()):
        p = self.profile(user_id)
        final, parts = self.blend(p)
        blocked = p.seen.copy()
        for mid in exclude_ids:
            if mid in self.index:
                blocked[self.index[mid]] = True
        order = [j for j in np.argsort(-final) if not blocked[j]][:limit]
        pct = self.match_pct(final)
        return [dict(movie_id=int(self.ids[j]), score=round(float(final[j]), 3), match=int(pct[j]), reasons=self.reasons(j, p, parts))
                for j in order]

    @serving
    def match(self, user_id: int, movie_ids: list[int]):
        p = self.profile(user_id)
        if not p.weights.any():
            return {}
        final, _ = self.blend(p)
        pct = self.match_pct(final)
        return {str(mid): int(pct[self.index[mid]]) for mid in movie_ids if mid in self.index}

    @serving
    def similar(self, movie_id: int, limit=12):
        if movie_id not in self.index:
            return []
        j = self.index[movie_id]
        latent = normalize(self.V) @ normalize(self.V[j:j + 1]).ravel()
        score = 0.5 * zscore(self.content_sim[j]) + 0.3 * zscore(self.cf_sim[j]) + 0.2 * zscore(latent) + 0.1 * zscore(self.bayes)
        score[j] = -np.inf
        return [int(self.ids[k]) for k in np.argsort(-score)[:limit]]

    def available(self, j: int, services: list[str]) -> bool:
        m = self.meta[j]
        return m["free"] or bool(set(m["providers"]) & set(services))

    @serving
    def decide(self, user_id: int, max_runtime=None, moods=(), company="solo", services=(), only_available=False, exclude_ids=(), k=3):
        """60-second decide mode: exactly k diverse picks that fit the moment."""
        p = self.profile(user_id)
        final, parts = self.blend(p)
        score = final.copy()
        ok = ~p.seen
        moods = list(moods or [])
        for j, m in enumerate(self.meta):
            if max_runtime and m["runtime"] > max_runtime:
                ok[j] = False
            if company == "family" and (m["cert"] not in FAMILY_SAFE or "Horror" in m["genres"]):
                ok[j] = False
            if only_available and not self.available(j, services):
                ok[j] = False
            hit = len(set(moods) & set(m["moods"]))
            if moods:
                score[j] += 1.1 * hit / len(moods) - (0.6 if hit == 0 else 0)
            if company == "family":
                score[j] += 0.5 * bool({"Family", "Animation"} & set(m["genres"]))
            elif company == "date":
                score[j] += 0.35 * ("romantic" in m["moods"]) + 0.15 * ("feel-good" in m["moods"]) - 0.3 * ("dark" in m["moods"])
            elif company == "friends":
                score[j] += 0.3 * bool({"funny", "thrilling", "action-packed", "scary"} & set(m["moods"]))
        for mid in exclude_ids:
            if mid in self.index:
                ok[self.index[mid]] = False
        cand = [j for j in np.argsort(-score) if ok[j]][:40]
        picks = []
        while cand and len(picks) < k:   # maximal marginal relevance: good *and* different from each other
            best = max(cand, key=lambda j: 0.75 * score[j] - 0.9 * max((self.content_sim[j, q] for q in picks), default=0))
            picks.append(best)
            cand.remove(best)
        pct = self.match_pct(final)
        result = []
        for j in picks:
            m = self.meta[j]
            why = []
            matched = [x for x in moods if x in m["moods"]]
            if matched:
                why.append(f"{matched[0].capitalize()}, like you asked")
            if max_runtime:
                h, mins = divmod(m["runtime"], 60)
                why.append(f"Fits your time: {f'{h}h ' if h else ''}{mins}m")
            why += self.reasons(j, p, parts)
            result.append(dict(movie_id=int(self.ids[j]), match=int(pct[j]), reasons=why[:3]))
        return result

    @serving
    def group(self, user_ids: list[int], limit=15, max_runtime=None, moods=(), family=False):
        """Group mode: rank films by average happiness, protected by least-misery."""
        per = {}
        seen_all = np.ones(len(self.ids), dtype=bool)
        seen_any = np.zeros(len(self.ids), dtype=bool)
        for u in user_ids:
            p = self.profile(u)
            final, _ = self.blend(p)
            per[u] = self.match_pct(final).astype(float)
            seen_all &= p.seen
            seen_any |= p.seen
        mat = np.vstack(list(per.values()))
        score = 0.5 * mat.mean(0) + 0.5 * mat.min(0) - 6 * seen_any
        for j, m in enumerate(self.meta):
            if seen_all[j] or (max_runtime and m["runtime"] > max_runtime):
                score[j] = -np.inf
            if family and (m["cert"] not in FAMILY_SAFE or "Horror" in m["genres"]):
                score[j] = -np.inf
            if moods:
                score[j] += 8 * len(set(moods) & set(m["moods"])) / len(moods)
        order = [j for j in np.argsort(-score) if np.isfinite(score[j])][:limit]
        return [dict(movie_id=int(self.ids[j]), group_score=round(float(score[j]), 1),
                     members={str(u): int(per[u][j]) for u in user_ids}) for j in order]

    @serving
    def taste(self, user_id: int):
        """Taste DNA: which genres and moods this user rates above their own average."""
        p = self.profile(user_id)
        genres, moods = {}, {}
        for j, w in enumerate(p.weights):
            if w == 0:
                continue
            for g in self.meta[j]["genres"]:
                genres.setdefault(g, []).append(w)
            for m in self.meta[j]["moods"]:
                moods.setdefault(m, []).append(w)
        fmt = lambda d: sorted(({"name": k, "score": round(float(np.mean(v)), 3), "count": len(v)} for k, v in d.items() if len(v) >= 2),
                               key=lambda x: -x["score"])
        return {"genres": fmt(genres), "moods": fmt(moods), "ratings": p.n_ratings}
