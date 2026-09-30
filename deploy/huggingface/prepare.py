"""Assembles the Hugging Face Space for the Moviq demo, and optionally uploads it.

    python deploy/huggingface/prepare.py                      # build deploy/huggingface/space/
    python deploy/huggingface/prepare.py --upload you/moviq   # ...and upload it (run `hf auth login` first)

The Space gets the app source, the trained models and a dump of the local database (from the
moviq-db Docker container). Raw training datasets (IMDb, Goodreads, MovieLens files) are not
included; the demo server ships the trained models only, so text-model retraining is off there.
"""
from __future__ import annotations

import argparse
import gzip
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / "space"

SKIP_DIRS = {"node_modules", "dist", "__pycache__", ".venv", "external"}
SKIP_FILES = {".env"}


def copy_tree(src: Path, dst: Path):
    for path in src.rglob("*"):
        rel = path.relative_to(src)
        if any(part in SKIP_DIRS for part in rel.parts) or path.name in SKIP_FILES or path.is_dir():
            continue
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)


def dump_database(target: Path):
    """Plain SQL dump without owners or grants; open group rooms are left out."""
    cmd = ["docker", "exec", "moviq-db", "pg_dump", "-U", "moviq", "--no-owner", "--no-privileges",
           "--exclude-table-data=room_votes", "--exclude-table-data=room_members", "--exclude-table-data=watch_rooms", "moviq"]
    sql = subprocess.run(cmd, check=True, capture_output=True).stdout
    with gzip.open(target, "wb", compresslevel=9) as f:
        f.write(sql)


def build():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for name in ("Dockerfile", "start.sh", "README.md"):
        shutil.copy2(HERE / name, OUT / name)
    copy_tree(ROOT / "client", OUT / "client")
    (OUT / "server").mkdir()
    for name in ("package.json", "package-lock.json"):
        shutil.copy2(ROOT / "server" / name, OUT / "server" / name)
    copy_tree(ROOT / "server" / "src", OUT / "server" / "src")
    copy_tree(ROOT / "ml", OUT / "ml")
    models = sorted((OUT / "ml" / "models").glob("*.joblib"))
    if not models:
        raise SystemExit("No trained models in ml/models. Start the ML service once locally so it trains them.")
    dump_database(OUT / "moviq.sql.gz")
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file()) / 1e6
    print(f"Built {OUT} ({size:.0f} MB): models {[m.name for m in models]}, database dump "
          f"{(OUT / 'moviq.sql.gz').stat().st_size / 1e6:.1f} MB")


def upload(repo_id: str):
    from huggingface_hub import HfApi
    api = HfApi()
    api.create_repo(repo_id, repo_type="space", space_sdk="docker", exist_ok=True)
    api.upload_folder(repo_id=repo_id, repo_type="space", folder_path=OUT, commit_message="Deploy Moviq demo",
                      delete_patterns=["*"])
    user, name = repo_id.split("/")
    print(f"Uploaded. Build logs: https://huggingface.co/spaces/{repo_id}")
    print(f"App link to share:   https://{user.lower()}-{name.lower().replace('_', '-')}.hf.space")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--upload", metavar="USER/SPACE", help="upload to this Hugging Face Space after building")
    args = parser.parse_args()
    build()
    if args.upload:
        upload(args.upload)
