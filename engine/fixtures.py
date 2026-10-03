"""Fixture loaders (no network). Every loader returns plain CONTRACTS.md-shaped dicts/lists."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
DEFAULT_FORECAST = "forecast_2026-10-04.json"


@lru_cache(maxsize=None)
def _load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text())


def roster() -> list[dict[str, Any]]:
    return [dict(a) for a in _load("roster.json")["roster"]]


def roster_is_synthetic() -> bool:
    return bool(_load("roster.json").get("synthetic", False))


def plan_is_synthetic() -> bool:
    return bool(_load("plan.json").get("synthetic", False))


def plan() -> dict[str, Any]:
    p = _load("plan.json")["plan"]
    return json.loads(json.dumps(p))  # deep copy


def forecast(name: str = DEFAULT_FORECAST) -> list[dict[str, Any]]:
    return [dict(h) for h in _load(name)["hours"]]


def forecast_meta(name: str = DEFAULT_FORECAST) -> dict[str, Any]:
    d = _load(name)
    return {k: v for k, v in d.items() if k != "hours"}
