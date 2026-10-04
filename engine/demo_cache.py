"""On-disk cache for demo-mode optimizer results, so restarting the engine doesn't repeat a cold search.

Key = SHA-256 of (kind, preset, plan, roster, weather, request options, input labels, code version). The code version
hashes every engine .py file and constants.yaml, so any model, optimizer or constant change misses the cache. Files
live in .cache/demo/ (git-ignored; override with HEATTWIN_CACHE_DIR). Only ?demo=1 results are cached: they are
deterministic (pinned forecast, fixed seed and iteration caps). `make warm` still runs every demo call as a check.
"""
from __future__ import annotations

import hashlib
import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]


def cache_dir() -> Path:
    return Path(os.environ.get("HEATTWIN_CACHE_DIR", ROOT / ".cache" / "demo"))


@lru_cache(maxsize=1)
def code_version() -> str:
    h = hashlib.sha256()
    eng = ROOT / "engine"
    for p in sorted([*eng.rglob("*.py"), eng / "constants.yaml"]):
        if "tests" in p.parts or "__pycache__" in p.parts:
            continue
        h.update(str(p.relative_to(ROOT)).encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def key(kind: str, preset: str, plan: Any, roster: Any, weather: Any, options: Any, labels: Any) -> str:
    blob = json.dumps({"kind": kind, "preset": preset, "plan": plan, "roster": roster, "weather": weather,
                       "options": options, "labels": labels, "code": code_version()}, sort_keys=True, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def load(k: Optional[str]) -> Optional[dict[str, Any]]:
    if not k:
        return None
    p = cache_dir() / f"{k}.json"
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def save(k: Optional[str], value: dict[str, Any]) -> None:
    if not k:
        return
    d = cache_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f".{k}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(value))
        tmp.replace(d / f"{k}.json")      # atomic: a crash never leaves a half-written entry
    except OSError:
        pass                              # read-only disk: the in-memory cache still works
