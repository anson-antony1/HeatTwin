"""The live-demo athlete: a real person's profile from git-ignored ``profiles/local/*.json`` (laptop), else the fictional
``fixtures/profiles/demo_athlete_live.json`` ("Demo athlete (live)", synthetic; always on Render).

``HEATTWIN_PROFILE``: unset → the first complete local profile, else the fictional one; ``demo`` → the fictional one;
a file stem (``anson``) → that local file. A local profile with any required field null is never used — the engine says
so in the labels and uses the fictional one. Personal data stays out of the repo (profiles/local/ is git-ignored).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
LOCAL_DIR = ROOT / "profiles" / "local"
DEMO_FILE = ROOT / "fixtures" / "profiles" / "demo_athlete_live.json"
REQUIRED = ("id", "name", "height_m", "mass_kg", "age_yr", "sex", "hr_rest_bpm", "acclimatization_day")


def _missing(p: dict[str, Any]) -> list[str]:
    return [k for k in REQUIRED if p.get(k) in (None, "")]


def _clean(p: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in p.items() if not k.startswith("_")}


def demo_profile() -> dict[str, Any]:
    return _clean(json.loads(DEMO_FILE.read_text())["profile"])


def load(choice: Optional[str] = None) -> tuple[dict[str, Any], list[str]]:
    """(athlete dict for the live session roster, labels)."""
    choice = (choice if choice is not None else os.environ.get("HEATTWIN_PROFILE", "")).strip()
    labels: list[str] = []
    if choice.lower() != "demo":
        files = sorted(LOCAL_DIR.glob("*.json")) if LOCAL_DIR.exists() else []
        if choice:
            files = [f for f in files if f.stem == choice]
            if not files:
                labels.append(f"no local profile '{choice}' — fictional demo athlete used")
        for f in files:
            try:
                p = _clean(json.loads(f.read_text()))
            except (OSError, json.JSONDecodeError):
                labels.append(f"local profile {f.name} unreadable — fictional demo athlete used")
                continue
            miss = _missing(p)
            if miss:
                labels.append(f"local profile {f.name} incomplete ({', '.join(miss)}) — fictional demo athlete used")
                continue
            return p, [f"live profile: {p['name']} (local, not in the repo)"]
    p = demo_profile()
    return p, [*labels, f"live profile: {p['name']} (fictional, synthetic)"]
