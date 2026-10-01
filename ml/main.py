"""Moviq ML service: recommendations, decide/group ranking, Spoiler Shield, sentiment,
and the learner that keeps all of them training on live data."""
from __future__ import annotations

import os
import secrets
import threading
import time
import traceback
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from learner import Learner
from learning import Registry
from recommender import Recommender
from sentiment import SentimentModel
from spoiler import SpoilerModel

rec = Recommender(serving=True)
spoiler = SpoilerModel()
sentiment = SentimentModel()
learner = Learner(rec, spoiler, sentiment)


# Loading the models and building the recommender takes seconds on a laptop but minutes on a small
# free instance. The port opens at once and the work happens in the background: until it's done,
# calls get a quick 503 (the API falls back to simpler rankings) instead of hanging.
WARMUP = {"ready": False, "stage": "starting", "error": None}


def warm_up():
    """Loads everything; a failed step (say, the database still waking) is retried with backoff."""
    delay = 5
    while True:
        try:
            if not spoiler.ready:
                WARMUP["stage"] = "loading the Spoiler Shield"
                metrics = spoiler.load_or_train()
                print(f"[spoiler] v{spoiler.version} ready {metrics}")
            if not sentiment.ready:
                WARMUP["stage"] = "loading the sentiment model"
                if sentiment.load():
                    print(f"[sentiment] v{sentiment.version} ready {sentiment.metrics}")
                else:
                    print("[sentiment] no saved model yet; the learner will train it in the background")
            WARMUP["stage"] = "building the recommender"
            rec.fit()
            print(f"[recommender] fitted on {len(rec.ids)} films, {len(rec.user_index)} people")
            learner.start()
            WARMUP.update(ready=True, stage="ready", error=None)
            return
        except Exception as e:
            WARMUP["error"] = f"{type(e).__name__}: {e}"
            print(f"[warm-up] {WARMUP['stage']} failed ({WARMUP['error']}); retrying in {delay}s")
            traceback.print_exc()
            time.sleep(delay)
            delay = min(delay * 2, 60)


@asynccontextmanager
async def lifespan(_app):
    threading.Thread(target=warm_up, daemon=True, name="warm-up").start()
    yield


app = FastAPI(title="Moviq ML", lifespan=lifespan)
ML_TOKEN = os.environ.get("ML_TOKEN")


@app.middleware("http")
async def require_token(request: Request, call_next):
    """When ML_TOKEN is set (a publicly reachable deployment), every call but /health must carry it."""
    if ML_TOKEN and request.url.path != "/health" and \
            not secrets.compare_digest(request.headers.get("x-moviq-token", ""), ML_TOKEN):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    if not WARMUP["ready"] and request.url.path != "/health":
        return JSONResponse({"detail": f"Warming up: {WARMUP['stage']}"}, status_code=503, headers={"Retry-After": "30"})
    return await call_next(request)


class TextIn(BaseModel):
    text: str
    review_id: int | None = None


class TextsIn(BaseModel):
    texts: list[str]


class RecIn(BaseModel):
    user_id: int
    limit: int = 20
    exclude_ids: list[int] = []
    with_match: bool = False


class MatchIn(BaseModel):
    user_id: int
    movie_ids: list[int]


class DecideIn(BaseModel):
    user_id: int
    max_runtime: int | None = None
    moods: list[str] = []
    company: str = "solo"
    services: list[str] = []
    only_available: bool = False
    exclude_ids: list[int] = []


class GroupIn(BaseModel):
    user_ids: list[int] = Field(min_length=1)
    limit: int = 15
    max_runtime: int | None = None
    moods: list[str] = []
    family: bool = False


@app.get("/health")
def health():
    """Always 200 while the process is up (hosts use it as a liveness check); "ready" says whether it can serve."""
    return {"ok": True, "ready": WARMUP["ready"], "stage": WARMUP["stage"], "error": WARMUP["error"],
            "spoiler": spoiler.version, "sentiment": sentiment.version, "recommender": rec.weights_version,
            "movies": len(getattr(rec, "ids", []))}


class RefreshIn(BaseModel):
    user_id: int | None = None


@app.post("/refresh")
def refresh(body: RefreshIn | None = None):
    rec.mark_dirty(body.user_id if body else None)
    return {"ok": True}


# ── Recommendations ─────────────────────────────────────────────────────
@app.post("/recommend")
def recommend(body: RecIn):
    return rec.recommend(body.user_id, body.limit, body.exclude_ids, body.with_match)


@app.post("/match")
def match(body: MatchIn):
    return rec.match(body.user_id, body.movie_ids)


@app.get("/similar/{movie_id}")
def similar(movie_id: int, limit: int = 12):
    return rec.similar(movie_id, limit)


@app.post("/decide")
def decide(body: DecideIn):
    return rec.decide(**body.model_dump())


@app.post("/group")
def group(body: GroupIn):
    return rec.group(**body.model_dump())


@app.get("/taste/{user_id}")
def taste(user_id: int):
    return rec.taste(user_id)


# ── Text understanding ──────────────────────────────────────────────────
@app.post("/analyze")
def analyze(body: TextIn):
    """Spoiler spans + sentiment + aspects for a review; human votes override the model."""
    votes = learner.human_votes([body.review_id]).get(body.review_id) if body.review_id else None
    return learner.analyze(body.text, votes)


@app.post("/reviews/{review_id}/rescore")
def rescore(review_id: int):
    result = learner.rescore_review(review_id)
    if result is None:
        raise HTTPException(404, "No review text to score")
    return result


@app.post("/spoiler/analyze")
def spoiler_analyze(body: TextIn):
    return spoiler.analyze(body.text)


@app.post("/spoiler/batch")
def spoiler_batch(body: TextsIn):
    return [spoiler.analyze(t) for t in body.texts]


# ── Learning ────────────────────────────────────────────────────────────
@app.get("/models")
def models():
    return {
        "live": {
            "spoiler": {"version": spoiler.version, "metrics": spoiler.metrics},
            "sentiment": {"version": sentiment.version, "metrics": sentiment.metrics, "ready": sentiment.ready},
            "recommender": {"version": rec.weights_version, "weights": rec.weights},
        },
        "learner": learner.status(),
        "history": Registry.history(80),
    }


@app.post("/learn/{model}")
def learn(model: str):
    if model not in ("spoiler", "sentiment", "recommender"):
        raise HTTPException(404, "Unknown model")
    if not learner.trainable(model):
        raise HTTPException(409, "Retraining is off on this server: it ships the trained model without the dataset it was trained on.")
    if learner.busy.locked():
        raise HTTPException(409, f"The learner is busy ({learner.activity}). Try again shortly.")
    result = learner.run(model, "manual retrain")
    learner.score_stale_reviews()
    return result
