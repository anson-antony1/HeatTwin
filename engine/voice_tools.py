"""Server side of the "Talk to the Twin" client tools. Each returns a small JSON object of NUMBERS the voice agent may
quote (it may only speak numbers that came from a tool), plus a ``say`` sentence that already passed engine/guard.py.

what_if(change)         → before/after team summary for one plan edit (gear, minutes, shade, move, remove, add break)
athlete_status(id)      → one athlete's estimate on the current plan
field_conditions()      → hourly WBGT / FHSAA zone over the practice window and the forecast's source
Every output carries "estimate — planning only".
"""
from __future__ import annotations

import copy
from typing import Any, Mapping, Sequence

import numpy as np

from engine import guard
from engine.physio import twonode

ESTIMATE = twonode.ESTIMATE_LABEL


def _summary(res: Mapping[str, Any]) -> dict[str, Any]:
    ath = res["athletes"]
    peaks = [a["peak_core_c_p95"] for a in ath]
    crosses = [a["first_cross_min"] for a in ath if a["first_cross_min"] is not None]
    return {
        "athletes": len(ath),
        "over_limit": sum(a["status"] == "over_limit" for a in ath),
        "near_limit": sum(a["status"] == "near_limit" for a in ath),
        "max_p95_c": round(max(peaks), 2),
        "team_mean_p95_c": round(float(np.mean(peaks)), 2),
        "first_cross_min": min(crosses) if crosses else None,
        "limit_c": res["limit_core_c"],
        "fhsaa_violations": len(res["fhsaa_violations"]),
        "practice_min": len(res["times"]) * res["step_min"],
    }


def apply_change(plan: Mapping[str, Any], change: Mapping[str, Any]) -> dict[str, Any]:
    """Apply one edit: {drill_id, gear?, duration_min?, shade?, move_to?, remove?} or {add_break_after, minutes}."""
    p = copy.deepcopy(dict(plan))
    drills = p["drills"]
    if "add_break_after" in change:
        i = next(k for k, d in enumerate(drills) if d["id"] == change["add_break_after"])
        drills.insert(i + 1, {"id": "wb_whatif", "name": "Water break (shade, what-if)",
                              "duration_min": int(change.get("minutes", 4)), "intensity": "rest", "gear": drills[i]["gear"],
                              "shade": True, "is_break": True, "priority": 1, "movable": True})
        return p
    i = next((k for k, d in enumerate(drills) if d["id"] == change["drill_id"]), None)
    if i is None:
        raise KeyError(f"no drill {change.get('drill_id')!r} in the plan")
    d = drills[i]
    if change.get("remove"):
        drills.pop(i)
        return p
    for key in ("gear", "duration_min", "shade", "intensity"):
        if key in change:
            d[key] = change[key]
            if key == "gear":
                d.pop("gear_by_athlete", None) if change["gear"] == "none" else None
    if "move_to" in change:
        drills.insert(max(0, min(int(change["move_to"]), len(drills) - 1)), drills.pop(i))
    return p


def what_if(roster, plan, weather, change, *, settings=None, seed: int = 0) -> dict[str, Any]:
    before = twonode.simulate_roster(roster, plan, weather, settings=settings, seed=seed)
    after_plan = apply_change(plan, change)
    after = twonode.simulate_roster(roster, after_plan, weather, settings=settings, seed=seed)
    b, a = _summary(before), _summary(after)
    delta = round(a["team_mean_p95_c"] - b["team_mean_p95_c"], 2)
    say = (f"With that change the estimated team-average peak goes from {b['team_mean_p95_c']} to "
           f"{a['team_mean_p95_c']} °C, and {a['over_limit']} of {a['athletes']} athletes are over the "
           f"{a['limit_c']} °C planning line, versus {b['over_limit']} before.")
    return {"before": b, "after": a, "delta_team_mean_p95_c": delta, "change": dict(change),
            "say": guard.check(say, source="voice.what_if")["redacted_text"], "labels": [ESTIMATE]}


def athlete_status(res: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], athlete_id: str) -> dict[str, Any]:
    a = next((x for x in res["athletes"] if x["id"] == athlete_id), None)
    if a is None:
        q = athlete_id.lower()
        a = next((x for x in res["athletes"] if q in str(x.get("name", "")).lower()), None)
    if a is None:
        raise KeyError(f"no athlete {athlete_id!r}")
    r = next(x for x in roster if x["id"] == a["id"])
    out = {"id": a["id"], "name": a.get("name"), "position": r.get("position"),
           "acclimatization_day": r.get("acclimatization_day"), "gear_limit": r.get("gear_limit"),
           "peak_p50_c": round(max(a["core_c_p50"]), 2), "peak_p95_c": round(a["peak_core_c_p95"], 2),
           "status": a["status"], "first_cross_min": a["first_cross_min"], "limit_c": res["limit_core_c"],
           "labels": [ESTIMATE]}
    when = f"from minute {a['first_cross_min']:g}" if a["first_cross_min"] is not None else "at no point"
    say = (f"{a.get('name')}: estimated peak {out['peak_p50_c']} °C typical and {out['peak_p95_c']} °C at the 95th "
           f"percentile; above the {res['limit_core_c']} °C planning line {when}. Estimate, planning only.")
    out["say"] = guard.check(say, source="voice.athlete_status")["redacted_text"]
    return out


def field_conditions(res: Mapping[str, Any]) -> dict[str, Any]:
    hours = [{"time": h["time"][11:16], "wbgt_f": h["wbgt_f"], "fhsaa_zone": h["fhsaa_zone"], "air_temp_c": h["air_temp_c"],
              "rh_pct": h["rh_pct"], "source": h["source"]} for h in res["weather"]]
    srcs = sorted({h["source"] for h in hours})
    say = ("Practice hours: " + "; ".join(f"{h['time']} WBGT {h['wbgt_f']:.0f} °F, zone {h['fhsaa_zone']}" for h in hours)
           + f". Source: {', '.join(srcs)}.")
    return {"hours": hours, "sources": srcs, "say": guard.check(say, source="voice.field")["redacted_text"],
            "labels": [ESTIMATE] + (["forecast is fixture"] if "fixture" in srcs else [])}
