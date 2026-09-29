"""Downloads the public datasets Moviq bootstraps from into ml/data/external (git-ignored).

  MovieLens latest-small  (GroupLens, ~1 MB)  real 0.5–5★ ratings from 610 people, with TMDB/IMDb ids
  IMDb Large Movie Review (Maas et al. 2011, ~84 MB)  50k movie reviews labelled positive/negative
  Goodreads spoilers      (Wan et al. 2019, ~620 MB)  1.3M reviews with sentence-level spoiler labels
                          (sampled down to ~60k sentences; the archive is deleted afterwards)

All are free for non-commercial research use. Cite them if you publish results:
  F. Maxwell Harper and Joseph A. Konstan. 2015. The MovieLens Datasets: History and Context.
  Andrew L. Maas et al. 2011. Learning Word Vectors for Sentiment Analysis.
  Mengting Wan et al. 2019. Fine-Grained Spoiler Detection from Large-Scale Review Corpora. ACL.

    .venv/Scripts/python download_data.py             MovieLens + IMDb
    .venv/Scripts/python download_data.py goodreads   also the Goodreads spoiler sample
"""
import csv
import json
import random
import sys
import gzip
import io
import re
import tarfile
import urllib.request
import zipfile
from pathlib import Path

EXT = Path(__file__).parent / "data" / "external"
MOVIELENS = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip"
IMDB = "https://ai.stanford.edu/~amaas/data/sentiment/aclImdb_v1.tar.gz"
GOODREADS = "https://mcauleylab.ucsd.edu/public_datasets/gdrive/goodreads/goodreads_reviews_spoiler.json.gz"
SPOILER_QUOTA = 30000          # spoiler sentences to keep
HARD_NEGATIVE_QUOTA = 15000    # non-spoiler sentences from reviews that do contain spoilers
EASY_NEGATIVE_QUOTA = 15000    # sentences from spoiler-free reviews
CR = chr(13)                   # progress lines overwrite themselves


def fetch(url: str, dest: Path):
    if dest.exists():
        print(f"  already have {dest.name}")
        return
    print(f"  downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        done = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r    {done / total:5.1%} of {total / 1e6:.0f} MB", end="")
    print()
    tmp.rename(dest)


def movielens():
    print("MovieLens latest-small")
    z = EXT / "ml-latest-small.zip"
    fetch(MOVIELENS, z)
    with zipfile.ZipFile(z) as zf:
        for name in ("ratings.csv", "links.csv", "movies.csv"):
            target = EXT / "movielens" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(zf.read(f"ml-latest-small/{name}"))
    print("  extracted ratings.csv, links.csv, movies.csv")


def imdb():
    print("IMDb Large Movie Review dataset")
    out = EXT / "imdb_reviews.csv.gz"
    if out.exists():
        print(f"  already have {out.name}")
        return
    tgz = EXT / "aclImdb_v1.tar.gz"
    fetch(IMDB, tgz)
    # Stream straight out of the archive (100k small files are slow to extract on Windows)
    pattern = re.compile(r"aclImdb/(train|test)/(pos|neg)/\d+_(\d+)\.txt$")
    n = 0
    with tarfile.open(tgz, "r:gz") as tf, gzip.open(out, "wt", encoding="utf-8", newline="") as g:
        w = csv.writer(g)
        w.writerow(["split", "label", "stars", "text"])
        for member in tf:
            m = pattern.match(member.name)
            if not m:
                continue
            text = tf.extractfile(member).read().decode("utf-8", "replace").replace("<br />", " ").strip()
            w.writerow([m.group(1), 1 if m.group(2) == "pos" else 0, m.group(3), text])
            n += 1
    tgz.unlink()
    print(f"  wrote {n} reviews to {out.name} (archive removed)")


def clean_sentence(text: str) -> str | None:
    text = re.sub(r"\(view spoiler\)\[|\(hide spoiler\)\]", "", text).strip()
    # Sentences that talk about spoilers ("no spoilers here") would teach a shortcut, not the concept
    if not 20 <= len(text) <= 300 or re.search(r"spoil", text, re.I) or not re.search(r"[a-z]", text):
        return None
    return text


def goodreads():
    print("Goodreads spoiler dataset")
    out = EXT / "goodreads_spoilers.csv.gz"
    if out.exists():
        print(f"  already have {out.name}")
        return
    gz = EXT / "goodreads_reviews_spoiler.json.gz"
    fetch(GOODREADS, gz)
    rng = random.Random(5)
    pos, hard, easy = [], [], []
    with gzip.open(gz, "rt", encoding="utf-8") as f:
        for n, line in enumerate(f):
            review = json.loads(line)
            sentences = [(label, clean_sentence(text)) for label, text in review["review_sentences"]]
            sentences = [(label, text) for label, text in sentences if text]
            rid = review["review_id"]
            if review["has_spoiler"]:
                for label, text in sentences:
                    if label == 1 and len(pos) < SPOILER_QUOTA:
                        pos.append((rid, 1, text))
                    elif label == 0 and len(hard) < HARD_NEGATIVE_QUOTA and rng.random() < 0.25:
                        hard.append((rid, 0, text))
            elif len(easy) < EASY_NEGATIVE_QUOTA and rng.random() < 0.02:
                label, text = rng.choice(sentences) if sentences else (None, None)
                if text:
                    easy.append((rid, 0, text))
            if n % 50000 == 0:
                print(end=CR)
                print(f"  scanned {n:,} reviews: {len(pos):,} spoilers, {len(hard) + len(easy):,} non-spoilers", end="")
            if len(pos) >= SPOILER_QUOTA and len(hard) >= HARD_NEGATIVE_QUOTA and len(easy) >= EASY_NEGATIVE_QUOTA:
                break
    print()
    with gzip.open(out, "wt", encoding="utf-8", newline="") as g:
        w = csv.writer(g)
        w.writerow(["review_id", "label", "text"])
        w.writerows(pos + hard + easy)
    gz.unlink()
    print(f"  wrote {len(pos) + len(hard) + len(easy):,} sentences to {out.name} (archive removed)")


if __name__ == "__main__":
    EXT.mkdir(parents=True, exist_ok=True)
    movielens()
    imdb()
    if "goodreads" in sys.argv[1:]:
        goodreads()
    print("Done.")
