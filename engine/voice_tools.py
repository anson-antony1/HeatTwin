"""Server side of the voice Q&A tools (CONTRACTS v1.2/v1.3). Each returns a small JSON object of NUMBERS plus a ``say``
sentence the ENGINE wrote and passed through engine/guard.py — the only sentence the app shows or speaks.

what_if(change)         → before/after team summary for one plan edit (gear, minutes, shade, move, remove, add break)
athlete_status(id)      → one athlete's estimate on the current plan
field_conditions()      → hourly WBGT / FHSAA zone over the practice window and the forecast's source
Every output carries "estimate — planning only".
"""
from __future__ import annotations

import copy
import re
from typing import Any, Mapping, Optional, Sequence

import numpy as np

from engine import consts, guard
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


def fhsaa_break_min() -> int:
    """Default what-if break length: the FHSAA rest-break length (Policy 41 §41.8.3; constants.fhsaa_wbgt_zones)."""
    return int(min(z["break_min"] for z in consts.get("fhsaa_wbgt_zones.zones") if z.get("break_min")))


def _labels(res: Mapping[str, Any]) -> list[str]:
    """The result's own provenance labels (fixture plan/roster/forecast, settings, …), estimate label first."""
    labs = list(res.get("labels") or [])
    return [ESTIMATE] + [x for x in labs if x != ESTIMATE]


def _plain(name: Any) -> str:
    return re.sub(r"\s*\(fictional\)\s*", "", str(name or "")).strip()


def resolve_athlete(query: str, roster: Sequence[Mapping[str, Any]]) -> Optional[str]:
    """Athlete id for an id or a (partial) name on this roster; None if no single match."""
    q = str(query or "").strip().lower()
    if not q:
        return None
    for a in roster:
        if a["id"].lower() == q:
            return a["id"]
    hits = [a["id"] for a in roster if q in _plain(a.get("name")).lower() or _plain(a.get("name")).lower() in q]
    return hits[0] if len(hits) == 1 else None


def resolve_drill(query: str, plan: Mapping[str, Any]) -> Optional[str]:
    """Drill id for an id or a (partial) drill name on this plan; None if no single match."""
    q = str(query or "").strip().lower()
    if not q:
        return None
    drills = plan["drills"]
    for d in drills:
        if d["id"].lower() == q:
            return d["id"]
    names = [(d["id"], str(d.get("name", "")).lower()) for d in drills]
    hits = [i for i, n in names if q in n or (n and n in q)]
    if len(hits) == 1:
        return hits[0]
    words = [w for w in re.findall(r"[a-z]+", q) if len(w) > 2]
    hits = [i for i, n in names if words and all(w in n for w in words)]
    return hits[0] if len(hits) == 1 else None


def plan_summary(res: Mapping[str, Any]) -> dict[str, Any]:
    """Whole-plan summary + an engine-written sentence (voice intent ``plan_summary``)."""
    s = _summary(res)
    crosses = [a for a in res["athletes"] if a["first_cross_min"] is not None]
    lead = ""
    if crosses:
        m = min(a["first_cross_min"] for a in crosses)
        names = [_plain(a.get("name")) for a in crosses if a["first_cross_min"] == m]   # every athlete tied first
        who = names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]
        lead = f" First estimated over: {who} from minute {m:g}."
    say = (f"{s['over_limit']} of {s['athletes']} athletes are estimated over the {s['limit_c']} °C planning line "
           f"at the 95th percentile; the highest estimate is {s['max_p95_c']} °C.{lead} "
           f"{s['fhsaa_violations']} FHSAA issues in the plan. Estimate, planning only.")
    return {**s, "say": guard.check(say, source="voice.plan_summary")["redacted_text"], "labels": _labels(res)}


def optimize_summary(opt: Mapping[str, Any]) -> dict[str, Any]:
    """Optimizer result + an engine-written sentence (voice intent ``optimize``)."""
    after = _summary(opt["optimized"])
    notes = [x.removeprefix("fewest_changes: ").rstrip(".") + "." for x in opt.get("labels", [])
             if x.startswith("fewest_changes:")]
    notes = [n[0].upper() + n[1:] for n in notes]
    say = " ".join([*notes, opt.get("top_changes_text", ""),
                    f"The rewritten plan keeps {opt['load_kept_pct']}% of the training load with {len(opt['changes'])} "
                    f"changes; {after['over_limit']} of {after['athletes']} athletes are estimated over the "
                    f"{after['limit_c']} °C planning line and it has {after['fhsaa_violations']} FHSAA issues."]).strip()
    return {"feasible": opt["feasible"], "load_kept_pct": opt["load_kept_pct"], "changes": len(opt["changes"]),
            "after": after, "top_changes": opt.get("top_changes", []),
            "say": guard.check(say, source="voice.optimize")["redacted_text"], "labels": _labels(opt)}


def apply_change(plan: Mapping[str, Any], change: Mapping[str, Any]) -> dict[str, Any]:
    """Apply one edit: {drill_id, gear?, duration_min?, shade?, move_to?, remove?} or {add_break_after, minutes}."""
    p = copy.deepcopy(dict(plan))
    drills = p["drills"]
    if "add_break_after" in change:
        i = next((k for k, d in enumerate(drills) if d["id"] == change["add_break_after"]), None)
        if i is None:
            raise KeyError(f"no drill {change.get('add_break_after')!r} in the plan")
        minutes = change.get("minutes")
        drills.insert(i + 1, {"id": "wb_whatif", "name": "Water break (shade, what-if)",
                              "duration_min": int(minutes if minutes is not None else fhsaa_break_min()),
                              "intensity": "rest", "gear": drills[i]["gear"],
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


def what_if(roster, plan, weather, change, *, settings=None, seed: int = 0, n_ensemble: Optional[int] = None,
            extra_labels: Sequence[str] = ()) -> dict[str, Any]:
    kw: dict[str, Any] = {"settings": settings, "seed": seed, "extra_labels": extra_labels}
    if n_ensemble is not None:
        kw["n_ensemble"] = n_ensemble
    before = twonode.simulate_roster(roster, plan, weather, **kw)
    after_plan = apply_change(plan, change)
    after = twonode.simulate_roster(roster, after_plan, weather, **kw)
    b, a = _summary(before), _summary(after)
    delta = round(a["team_mean_p95_c"] - b["team_mean_p95_c"], 2)
    say = (f"With that change the estimated team-average peak goes from {b['team_mean_p95_c']} to "
           f"{a['team_mean_p95_c']} °C, and {a['over_limit']} of {a['athletes']} athletes are over the "
           f"{a['limit_c']} °C planning line, versus {b['over_limit']} before. Estimate, planning only.")
    return {"before": b, "after": a, "delta_team_mean_p95_c": delta, "change": dict(change),
            "say": guard.check(say, source="voice.what_if")["redacted_text"], "labels": _labels(before)}


def athlete_status(res: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], athlete_id: str) -> dict[str, Any]:
    aid = resolve_athlete(athlete_id, roster)
    a = next((x for x in res["athletes"] if x["id"] == aid), None)
    if a is None:
        raise KeyError(f"no single athlete matches {athlete_id!r}")
    r = next(x for x in roster if x["id"] == a["id"])
    out = {"id": a["id"], "name": a.get("name"), "position": r.get("position"),
           "acclimatization_day": r.get("acclimatization_day"), "gear_limit": r.get("gear_limit"),
           "peak_p50_c": round(max(a["core_c_p50"]), 2), "peak_p95_c": round(a["peak_core_c_p95"], 2),
           "status": a["status"], "first_cross_min": a["first_cross_min"], "limit_c": res["limit_core_c"],
           "labels": _labels(res)}
    head = (f"{_plain(a.get('name'))}: estimated peak {out['peak_p50_c']} °C typical and {out['peak_p95_c']} °C at the "
            f"95th percentile; ")
    if a["first_cross_min"] is not None:
        say = head + (f"above the {res['limit_core_c']} °C planning line from minute {a['first_cross_min']:g}. "
                      "Estimate, planning only.")
    else:  # no reassurance: a forecast below the line is not a clearance
        say = head + (f"the 95th-percentile estimate stays below the {res['limit_core_c']} °C planning line for the whole "
                      "plan. That is an estimate, not a clearance — review with your athletic trainer. "
                      "Estimate, planning only.")
    out["say"] = guard.check(say, source="voice.athlete_status")["redacted_text"]
    return out


def field_conditions(res: Mapping[str, Any]) -> dict[str, Any]:
    hours = [{"time": h["time"][11:16], "wbgt_f": h["wbgt_f"], "fhsaa_zone": h["fhsaa_zone"], "air_temp_c": h["air_temp_c"],
              "rh_pct": h["rh_pct"], "source": h["source"]} for h in res["weather"]]
    srcs = sorted({h["source"] for h in hours})
    say = ("Practice hours: " + "; ".join(f"{h['time']} WBGT {h['wbgt_f']:.0f} °F, zone {h['fhsaa_zone']}" for h in hours)
           + f". Source: {', '.join(srcs)}.")
    return {"hours": hours, "sources": srcs, "say": guard.check(say, source="voice.field")["redacted_text"],
            "labels": _labels(res) + (["forecast is fixture"] if "fixture" in srcs and "forecast is fixture"
                                       not in _labels(res) else [])}
