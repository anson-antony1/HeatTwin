"""FHSAA heat rules (Policy 41, 2025-26 Handbook) applied to a PracticePlan and hourly weather.

Signatures the optimizer depends on (CONTRACTS.md, keep exactly):
    zone(wbgt_f) -> int
    violations(plan, weather) -> list[{drill_id, rule, detail}]
Also: required_breaks(plan, weather), zone_rules(z), acclimatization_violations(plan, roster),
advisories(plan, weather).

Rules are read from constants.fhsaa_wbgt_zones / fhsaa_practice_limits. Checks in violations():
  * zone 5 → no outdoor activity (every drill in a zone-5 hour)
  * max activity time for the worst zone reached during practice (zone 3: 2 h, zone 4: 1 h), and the 3 h
    single-practice cap (§41.5.12)
  * separate shaded rest breaks per clock hour: a break = a contiguous run of ``is_break and shade`` minutes at
    least ``break_min`` long, credited to the hour it starts in; requirement prorated for partly covered hours
  * football gear: zone 3 no full pads unless zone 3 began after practice started (§41.8.3 pants exception);
    zone 4 no protective equipment; zone 4 no conditioning (drills with intensity "max", a DESIGN mapping)
  * cooling zone above 82.1 °F, only when the plan explicitly says ``site.cooling_zone: false`` (the field is
    optional and additive; when absent, advisories() reminds the coach instead of failing every plan)
"""
from __future__ import annotations

import math
from bisect import bisect_right
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Mapping, Sequence

from engine import consts


def _zones() -> list[dict[str, Any]]:
    return consts.get("fhsaa_wbgt_zones.zones")


def zone(wbgt_f: float) -> int:
    """FHSAA zone 1-5. WBGT is read to 0.1 °F (82.0 → zone 1, 82.1 → zone 2)."""
    w = float(Decimal(repr(float(wbgt_f))).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP))  # 82.05 → 82.1, as a display
    for z in _zones():
        if w <= z["wbgt_f_max"]:
            return int(z["zone"])
    return int(_zones()[-1]["zone"])


def zone_rules(z: int) -> dict[str, Any]:
    return next(r for r in _zones() if int(r["zone"]) == int(z))


def _t(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


class _Scan:
    """One pass over the plan's minutes: zone, WBGT and drill per minute, grouped into clock hours.

    Minute m starts at plan.start + m min; clock hour index = (start minute-of-hour + m) // 60, which is exact for
    any time zone without a DST change during practice.
    """

    def __init__(self, plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]):
        if not weather:
            raise ValueError("weather is empty")
        hours = sorted(weather, key=lambda h: _t(h["time"]))
        hts = [_t(h["time"]).timestamp() for h in hours]
        hzone = [int(h["fhsaa_zone"]) if h.get("fhsaa_zone") is not None else zone(h["wbgt_f"]) for h in hours]
        hwbgt = [h.get("wbgt_f") for h in hours]
        self.start = _t(plan["start"])
        t0 = self.start.timestamp()
        self.drills = list(plan["drills"])
        self.drill_of: list[int] = []        # drill index per minute
        for i, d in enumerate(self.drills):
            self.drill_of.extend([i] * int(round(float(d["duration_min"]))))
        n = len(self.drill_of)
        self.zone: list[int] = []
        self.wbgt: list[Any] = []
        k = max(bisect_right(hts, t0) - 1, 0)
        for m in range(n):                   # minutes are increasing: advance the hour pointer instead of bisecting
            ts = t0 + 60.0 * m
            while k + 1 < len(hts) and hts[k + 1] <= ts:
                k += 1
            self.zone.append(hzone[k])
            self.wbgt.append(hwbgt[k])
        off = self.start.minute
        self.hour_of = [(off + m) // 60 for m in range(n)]

    def hour_iso(self, idx: int) -> str:
        return (self.start.replace(minute=0, second=0, microsecond=0) + timedelta(hours=idx)).isoformat()

    def max_wbgt(self) -> float:
        vals = [float(w) for w in self.wbgt if w is not None]
        return max(vals) if vals else -math.inf


def _is_rest_break(d: Mapping[str, Any]) -> bool:
    return bool(d.get("is_break")) and bool(d.get("shade"))


def _breaks(sc: _Scan) -> list[dict[str, Any]]:
    buckets: dict[int, dict[str, Any]] = {}
    rest = [_is_rest_break(d) for d in sc.drills]
    run_start, run_len = None, 0
    runs: list[tuple[int, int]] = []         # (start minute, length) of contiguous shaded-break runs
    for m, (di, h, z) in enumerate(zip(sc.drill_of, sc.hour_of, sc.zone)):
        b = buckets.get(h)
        if b is None:
            b = buckets[h] = {"hour": sc.hour_iso(h), "zone": z, "covered_min": 0, "break_min": 0, "breaks": 0}
        elif z > b["zone"]:
            b["zone"] = z
        b["covered_min"] += 1
        if rest[di]:
            b["break_min"] += 1
            if run_start is None:
                run_start, run_len = m, 0
            run_len += 1
        elif run_start is not None:
            runs.append((run_start, run_len))
            run_start = None
    if run_start is not None:
        runs.append((run_start, run_len))
    for b in buckets.values():
        r = zone_rules(b["zone"])
        n_per_hour, each = r["breaks_per_hour"] or 0, r["break_min"] or 0
        b["required_breaks"] = int(math.ceil(n_per_hour * b["covered_min"] / 60.0 - 1e-9))
        b["required_min"] = b["required_breaks"] * each
        b["min_break_len"] = each
    for m, length in runs:
        b = buckets[sc.hour_of[m]]
        if length >= b["min_break_len"]:
            b["breaks"] += 1
    return list(buckets.values())


def required_breaks(plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Per clock hour the practice touches: zone, covered minutes, separate breaks scheduled vs required."""
    return _breaks(_Scan(plan, weather))


def violations(plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    sc = _Scan(plan, weather)
    out: list[dict[str, str]] = []
    drill_zone: dict[int, int] = {}
    for di, z in zip(sc.drill_of, sc.zone):
        if z > drill_zone.get(di, 0):
            drill_zone[di] = z
    worst = max(drill_zone.values(), default=1)
    start_zone = sc.zone[0] if sc.zone else 1
    pants_ok = bool(consts.get("fhsaa_wbgt_zones.zone3_pants_if_rose_after_start", False)) and start_zone < 3

    for di, d in enumerate(sc.drills):
        if di not in drill_zone:             # zero-length drill
            continue
        z = drill_zone[di]
        r = zone_rules(z)
        if z >= 5:
            out.append({"drill_id": d["id"], "rule": "zone5_no_outdoor_activity", "detail": f"Zone {z}: {r['activity']}"})
            continue
        if z == 3 and d["gear"] == "full_pads" and not pants_ok:
            out.append({"drill_id": d["id"], "rule": "zone3_gear",
                        "detail": f"Zone 3 allows {r['gear']}; drill uses full pads"})
        if z == 4 and d["gear"] != "none":
            out.append({"drill_id": d["id"], "rule": "zone4_no_protective_gear",
                        "detail": f"Zone 4: {r['gear']}; drill uses {d['gear']}"})
        if z == 4 and d.get("intensity") == "max":
            out.append({"drill_id": d["id"], "rule": "zone4_no_conditioning",
                        "detail": "Zone 4: no conditioning (max-intensity drill)"})

    total = len(sc.drill_of)
    max_dur = zone_rules(worst)["max_duration_min"]
    if max_dur is not None and worst < 5 and total > max_dur:
        out.append({"drill_id": "plan", "rule": f"zone{worst}_max_duration",
                    "detail": f"Practice is {total} min; zone {worst} allows {max_dur} min"})
    cap = consts.get("fhsaa_practice_limits.max_single_practice_min")
    if total > cap:
        out.append({"drill_id": "plan", "rule": "max_single_practice",
                    "detail": f"Practice is {total} min; a single practice may not exceed {cap} min"})

    for b in _breaks(sc):
        if b["zone"] < 5 and b["breaks"] < b["required_breaks"]:
            out.append({"drill_id": "plan", "rule": f"zone{b['zone']}_breaks_per_hour",
                        "detail": f"Hour {b['hour']}: {b['breaks']} separate shaded rest breaks of "
                                  f"≥{b['min_break_len']} min scheduled, {b['required_breaks']} required for "
                                  f"{b['covered_min']} min of practice"})

    if plan.get("site", {}).get("cooling_zone") is False and sc.max_wbgt() >= _cooling_threshold():
        out.append({"drill_id": "plan", "rule": "cooling_zone_required",
                    "detail": f"WBGT reaches {sc.max_wbgt():.1f} °F; a cooling zone (cold-water immersion tub "
                              f"or TACO with a trained individual) is required above {_cooling_threshold()} °F"})
    return out


def _cooling_threshold() -> float:
    return float(consts.get("fhsaa_wbgt_zones.cooling_zone_required_above_wbgt_f"))


def advisories(plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    """Reminders that are not plan violations (the plan can't satisfy them by itself)."""
    w = _Scan(plan, weather).max_wbgt()
    out = []
    if w >= _cooling_threshold() and plan.get("site", {}).get("cooling_zone") is None:
        out.append({"drill_id": "plan", "rule": "cooling_zone_confirm",
                    "detail": f"Forecast WBGT reaches {w:.1f} °F: confirm a cooling zone (cold-water immersion tub or "
                              f"TACO, trained individual present) is set up"})
    if w > _zones()[0]["wbgt_f_max"]:
        out.append({"drill_id": "plan", "rule": "measure_on_site",
                    "detail": "Measure WBGT on site 15-20 min before practice and about every 30 min "
                              "(forecast WBGT is an estimate)"})
    return out


def acclimatization_violations(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]]) -> list[dict[str, str]]:
    """Football acclimatization gear (§41.5.7): days 1-2 helmet only, days 3-5 helmet + shoulder pads, day 6+ any."""
    lim = consts.get("fhsaa_practice_limits")
    order = {g: i for i, g in enumerate(lim["gear_order"])}
    steps = sorted(lim["football_gear_by_day"], key=lambda s: s["through_day"])
    out = []
    for d in plan["drills"]:
        ids = d.get("participants")
        for a in roster:
            if ids is not None and a["id"] not in ids:
                continue
            day = int(a.get("acclimatization_day", 1))
            cap = next((s["max_gear"] for s in steps if day <= s["through_day"]), None)
            if cap is not None and order[d["gear"]] > order[cap]:
                out.append({"drill_id": d["id"], "rule": "acclimatization_gear",
                            "detail": f"{a['id']} is on practice day {day}: gear limited to {cap}; drill uses {d['gear']}"})
    return out
