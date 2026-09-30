"""Downloads the trained models for a deployment that doesn't have them (they're not in git).

    python download_models.py        # fetches any of models/*.joblib that are missing

MODELS_URL points at a folder holding sentiment.joblib and spoiler.joblib; by default, the
models-v1 release of the GitHub repo.
"""
import os
import urllib.request
from pathlib import Path

MODELS_URL = os.environ.get("MODELS_URL", "https://github.com/Boovesh985/Moviq/releases/download/models-v1").rstrip("/")
DIR = Path(__file__).parent / "models"

DIR.mkdir(exist_ok=True)
for name in ("sentiment.joblib", "spoiler.joblib"):
    target = DIR / name
    if target.exists():
        print(f"{name}: already here")
        continue
    print(f"{name}: downloading from {MODELS_URL}")
    urllib.request.urlretrieve(f"{MODELS_URL}/{name}", target)
    print(f"{name}: {target.stat().st_size / 1e6:.1f} MB")
