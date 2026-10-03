"""LOCAL STUB of WS1's engine/fhsaa.py — same signatures, used only until fhsaa.py lands.

Rules read from constants.fhsaa_wbgt_zones (status SECONDARY). Checks implemented here, per the WS1 brief:
  * zone 5 → no outdoor activity
  * max practice duration for the worst zone during practice
  * required shaded-break minutes per clock hour (breaks_per_hour × break_min, prorated for the part of the
    hour the practice covers; counted as minutes of drills with is_break and shade)
  * gear restrictions (zone 3: no full pads; zone 4: no protective gear) and zone 4 "no conditioning"
Not checked here: the cooling-zone requirement above 82.1 °F (the plan has no field for it).
WS1 owns the authoritative implementation; replace by deleting this file once engine/fhsaa.py exists.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Mapping, Sequence

from engine import consts

STUB = True


def _zones() -> list[dict[str, Any]]:
    return consts.get("fhsaa_wbgt_zones.zones")


def zone(wbgt_f: float) -> int:
    for z in _zones():
        if wbgt_f <= z["wbgt_f_max"]:
            return int(z["zone"])
    return int(_zones()[-1]["zone"])


def zone_rules(z: int) -> dict[str, Any]:
    return next(r for r in _zones() if int(r["zone"]) == int(z))


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _hour_zone(weather: Sequence[Mapping[str, Any]], t: datetime) -> int:
    """Zone of the forecast hour containing t (nearest earlier hour; clamps to the ends)."""
    hours = sorted(weather, key=lambda h: _t(h["time"]))
    chosen = hours[0]
    for h in hours:
        if _t(h["time"]) <= t:
            chosen = h
    if chosen.get("fhsaa_zone") is not None:
        return int(chosen["fhsaa_zone"])
    return zone(float(chosen["wbgt_f"]))


def _minutes(plan: Mapping[str, Any]):
    """Yield (minute_start_time, drill) for every plan minute."""
    t = _t(plan["start"])
    for d in plan["drills"]:
        for _ in range(int(round(float(d["duration_min"])))):
            yield t, d
            t += timedelta(minutes=1)


def required_breaks(plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Per clock hour the practice touches: zone, covered minutes, required and scheduled shaded-break minutes."""
    buckets: dict[datetime, dict[str, Any]] = {}
    for t, d in _minutes(plan):
        hour = t.replace(minute=0, second=0, microsecond=0)
        b = buckets.setdefault(hour, {"hour": hour.isoformat(), "zone": 1, "covered_min": 0, "break_min": 0})
        b["zone"] = max(b["zone"], _hour_zone(weather, t))
        b["covered_min"] += 1
        if d.get("is_break") and d.get("shade"):
            b["break_min"] += 1
    out = []
    for b in buckets.values():
        r = zone_rules(b["zone"])
        per_hour = (r["breaks_per_hour"] or 0) * (r["break_min"] or 0)
        b["required_min"] = int(math.ceil(per_hour * b["covered_min"] / 60.0 - 1e-9))
        out.append(b)
    return out


def violations(plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    drill_zone: dict[str, int] = {}
    for t, d in _minutes(plan):
        drill_zone[d["id"]] = max(drill_zone.get(d["id"], 1), _hour_zone(weather, t))
    worst = max(drill_zone.values(), default=1)

    for d in plan["drills"]:
        z = drill_zone.get(d["id"], 1)
        r = zone_rules(z)
        if z >= 5:
            out.append({"drill_id": d["id"], "rule": "zone5_no_outdoor_activity",
                        "detail": f"Zone {z}: {r['activity']}"})
            continue
        if z == 3 and d["gear"] == "full_pads":
            out.append({"drill_id": d["id"], "rule": "zone3_gear",
                        "detail": f"Zone 3 allows {r['gear']}; drill uses full pads"})
        if z == 4 and d["gear"] != "none":
            out.append({"drill_id": d["id"], "rule": "zone4_no_protective_gear",
                        "detail": f"Zone 4: {r['gear']}; drill uses {d['gear']}"})
        if z == 4 and d.get("intensity") == "max":
            out.append({"drill_id": d["id"], "rule": "zone4_no_conditioning",
                        "detail": "Zone 4: no conditioning (max-intensity drill)"})

    total = sum(int(round(float(d["duration_min"]))) for d in plan["drills"])
    max_dur = zone_rules(worst)["max_duration_min"]
    if max_dur is not None and worst < 5 and total > max_dur:
        out.append({"drill_id": "plan", "rule": f"zone{worst}_max_duration",
                    "detail": f"Practice is {total} min; zone {worst} allows {max_dur} min"})

    for b in required_breaks(plan, weather):
        if b["zone"] < 5 and b["break_min"] < b["required_min"]:
            out.append({"drill_id": "plan", "rule": f"zone{b['zone']}_breaks_per_hour",
                        "detail": f"Hour {b['hour']}: {b['break_min']} shaded break min scheduled, "
                                  f"{b['required_min']} required for {b['covered_min']} min of practice"})
    return out
