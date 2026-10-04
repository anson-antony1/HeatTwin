"""Build step: download the fastembed text-embedding model into the project directory, then prove it loads offline.

    python scripts/fetch_fastembed_model.py

Env (same names the engine reads, engine/decide.py):
  FASTEMBED_MODEL      model name (default BAAI/bge-small-en-v1.5; fastembed maps it to a ~64 MB quantised ONNX file)
  FASTEMBED_CACHE_DIR  where the model files go (default ~/.cache/heattwin/fastembed; engine/decide.cache_dir)

The download is the only network call and it happens at build time; at run time set HF_HUB_OFFLINE=1 so the service
loads the files from FASTEMBED_CACHE_DIR and never reaches for the network. Not a metered API: a public file download.
Exit 1 if the model cannot be downloaded or cannot be loaded from the cache alone, so a broken model fails the build.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"


def main() -> int:
    from fastembed import TextEmbedding

    model = os.environ.get("FASTEMBED_MODEL", DEFAULT_MODEL)
    from engine import decide
    cache = str(decide.cache_dir())
    t = time.perf_counter()
    TextEmbedding(model_name=model, cache_dir=cache)                  # downloads into `cache` if absent
    print(f"fastembed: {model} downloaded to {cache} in {time.perf_counter() - t:.1f} s")
    t = time.perf_counter()
    offline = TextEmbedding(model_name=model, cache_dir=cache, local_files_only=True)   # no network allowed
    dim = len(next(iter(offline.embed(["warm-up"]))))
    print(f"fastembed: loaded from the cache alone, {dim}-dim vectors, in {time.perf_counter() - t:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
