"""Per-athlete gear: NATA 2009 acclimatization gear phasing and per-athlete gear in drills.

* ``athlete_gear_limit(a)``: the most protective equipment athlete ``a`` may wear today, from constants.nata_gear_phasing
  and ``acclimatization_day``. An explicit ``a["gear_limit"]`` (CONTRACTS v1.1, additive) can only tighten it.
* ``effective_gear(drill, athlete_id)``: ``drill["gear_by_athlete"][id]`` if present (CONTRACTS v1.1, additive), else
  ``drill["gear"]``.
* ``phasing_violations(plan, roster)``: one violation per drill listing every participating athlete above their limit.
"""
from __future__ import annotations

from typing import Any, Mapping, Sequence

from engine import consts
from engine.physio.clothing import GEAR_LEVELS

RULE = "nata_gear_phasing"
GEAR_LABEL = {"none": "no pads", "helmet": "helmet only", "helmet_shoulder_pads": "helmet + shoulder pads",
              "full_pads": "full pads"}


def rank(gear: str) -> int:
    return GEAR_LEVELS.index(gear)


def nata_limit(day: float) -> str:
    for ph in consts.get("nata_gear_phasing.phases"):
        if ph["first_day"] <= day <= ph["last_day"]:
            return ph["max_gear"]
    return consts.get("nata_gear_phasing.phases")[-1]["max_gear"]


def athlete_gear_limit(a: Mapping[str, Any]) -> str:
    lim = nata_limit(float(a.get("acclimatization_day", 1)))
    explicit = a.get("gear_limit")
    if explicit is not None and rank(explicit) < rank(lim):
        return explicit
    return lim


def effective_gear(drill: Mapping[str, Any], athlete_id: str) -> str:
    per = drill.get("gear_by_athlete") or {}
    return per.get(athlete_id, drill["gear"])


def participates(drill: Mapping[str, Any], athlete_id: str) -> bool:
    p = drill.get("participants")
    return p is None or athlete_id in p


def phasing_violations(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    out = []
    limits = {a["id"]: athlete_gear_limit(a) for a in roster}
    names = {a["id"]: a.get("name", a["id"]) for a in roster}
    days = {a["id"]: a.get("acclimatization_day") for a in roster}
    for d in plan["drills"]:
        over = [aid for aid in limits if participates(d, aid) and rank(effective_gear(d, aid)) > rank(limits[aid])]
        if over:
            who = "; ".join(f"{names[a]} (day {days[a]:g}: {GEAR_LABEL[effective_gear(d, a)]} > {GEAR_LABEL[limits[a]]})"
                            for a in over)
            out.append({"drill_id": d["id"], "rule": RULE,
                        "detail": f"{len(over)} athlete(s) above their acclimatization gear limit: {who}"})
    return out


def capped_gear_by_athlete(drill: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> dict[str, str]:
    """``gear_by_athlete`` that brings every athlete down to at most their limit (keeps existing lower overrides)."""
    per = dict(drill.get("gear_by_athlete") or {})
    for a in roster:
        g = effective_gear(drill, a["id"])
        lim = athlete_gear_limit(a)
        if rank(g) > rank(lim):
            per[a["id"]] = lim
    return per
