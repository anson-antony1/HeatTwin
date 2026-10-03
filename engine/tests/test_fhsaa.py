"""fhsaa.py: zone boundaries, separate-break counting across hours, gear/duration/zone-5 rules, adapter wiring."""
import pytest

from engine import fhsaa, fhsaa_adapter, fixtures

START = "2026-10-04T15:30:00-04:00"


def weather(*zones_by_hour, start_hour=15):
    """Hourly weather from 15:00 with the given zones (wbgt_f picked inside each zone)."""
    rep = {1: 80.0, 2: 85.0, 3: 89.0, 4: 91.0, 5: 95.0}
    return [{"time": f"2026-10-04T{start_hour + i:02d}:00:00-04:00", "air_temp_c": 30, "rh_pct": 70, "wind_m_s": 2,
             "cloud_cover_pct": 50, "wbgt_f": rep[z], "fhsaa_zone": z, "source": "fixture"}
            for i, z in enumerate(zones_by_hour)]


def drill(id, minutes, gear="helmet", intensity="moderate", brk=False, shade=False):
    return {"id": id, "name": id, "duration_min": minutes, "intensity": "rest" if brk else intensity, "gear": gear,
            "shade": shade, "is_break": brk, "priority": 2, "movable": True}


def plan(*drills, start=START, **site):
    return {"id": "t", "site": {"name": "x", "lat": 29.65, "lon": -82.32, "surface": "grass", **site},
            "start": start, "drills": list(drills)}


def rules(v):
    return sorted(x["rule"] for x in v)


@pytest.mark.parametrize("w,z", [(81.9, 1), (82.0, 1), (82.04, 1), (82.05, 2), (82.1, 2), (87.0, 2), (87.1, 3),
                                 (90.0, 3), (90.1, 4), (92.0, 4), (92.1, 5), (110, 5)])
def test_zone_boundaries(w, z):
    assert fhsaa.zone(w) == z


def test_adapter_uses_real_module():
    assert fhsaa_adapter.USING_STUB is False
    assert fhsaa_adapter.zone is fhsaa.zone
    p, w = fixtures.plan(), fixtures.forecast()
    assert fhsaa_adapter.violations(p, w) == fhsaa.violations(p, w)   # adapter adds roster rules only when given one


def test_zone1_no_rules():
    assert fhsaa.violations(plan(drill("a", 120, gear="full_pads", intensity="max")), weather(1, 1, 1)) == []


def test_breaks_counted_per_clock_hour_across_boundary():
    # zone 2 → 3 separate ≥4-min breaks per hour, prorated: 15:30-16:00 needs 2, 16:00-17:00 needs 3
    p = plan(drill("a", 10), drill("b1", 4, brk=True, shade=True), drill("c", 10), drill("b2", 4, brk=True, shade=True),
             drill("d", 2),                                        # 15:30 + 30 = 16:00
             drill("e", 10), drill("b3", 4, brk=True, shade=True), drill("f", 10), drill("b4", 4, brk=True, shade=True),
             drill("g", 10), drill("b5", 4, brk=True, shade=True), drill("h", 18))
    hours = {b["hour"]: b for b in fhsaa.required_breaks(p, weather(2, 2, 2))}
    assert hours["2026-10-04T15:00:00-04:00"]["breaks"] == 2 and hours["2026-10-04T15:00:00-04:00"]["required_breaks"] == 2
    assert hours["2026-10-04T16:00:00-04:00"]["breaks"] == 3 and hours["2026-10-04T16:00:00-04:00"]["required_breaks"] == 3
    assert fhsaa.violations(p, weather(2, 2, 2)) == []


def test_break_straddling_the_hour_counts_where_it_starts():
    p = plan(drill("a", 28), drill("b", 4, brk=True, shade=True), drill("c", 28), start=START)   # break 15:58-16:02
    hours = {b["hour"][11:13]: b for b in fhsaa.required_breaks(p, weather(1, 1))}
    assert hours["15"]["breaks"] == 1 and hours["16"]["breaks"] == 0


def test_one_long_break_is_not_three_separate_breaks():
    p = plan(drill("a", 20), drill("b", 12, brk=True, shade=True), drill("c", 28), start="2026-10-04T15:00:00-04:00")
    v = fhsaa.violations(p, weather(2))
    assert rules(v) == ["zone2_breaks_per_hour"]


def test_short_or_unshaded_breaks_do_not_count():
    p = plan(drill("a", 14), drill("b1", 3, brk=True, shade=True), drill("c", 14), drill("b2", 4, brk=True, shade=False),
             drill("d", 14), drill("b3", 4, brk=True, shade=True), drill("e", 7), start="2026-10-04T15:00:00-04:00")
    (b,) = fhsaa.required_breaks(p, weather(2))
    assert b["breaks"] == 1 and b["required_breaks"] == 3


def test_zone3_full_pads_and_two_hour_limit():
    p = plan(*[drill(f"d{i}", 26, gear="full_pads") if i % 2 == 0 else drill(f"b{i}", 4, brk=True, shade=True, gear="full_pads")
               for i in range(9)], start="2026-10-04T15:00:00-04:00")       # 5×26 + 4×4 = 146 min
    r = rules(fhsaa.violations(p, weather(3, 3, 3)))
    assert "zone3_max_duration" in r and r.count("zone3_gear") == 9


def test_zone3_pants_exception_when_heat_rises_after_start():
    p = plan(drill("a", 30, gear="full_pads"), drill("b", 30, gear="full_pads"), start="2026-10-04T15:30:00-04:00")
    assert "zone3_gear" not in rules(fhsaa.violations(p, weather(2, 3)))    # started in zone 2
    assert "zone3_gear" in rules(fhsaa.violations(p, weather(3, 3)))        # started in zone 3


def test_zone4_gear_conditioning_and_one_hour():
    p = plan(drill("a", 40, gear="helmet"), drill("g", 30, gear="none", intensity="max"), start="2026-10-04T15:00:00-04:00")
    r = rules(fhsaa.violations(p, weather(4, 4)))
    assert {"zone4_no_protective_gear", "zone4_no_conditioning", "zone4_max_duration"} <= set(r)


def test_zone5_every_drill():
    p = plan(drill("a", 20, gear="none"), drill("b", 4, brk=True, shade=True, gear="none"), start="2026-10-04T15:00:00-04:00")
    assert rules(fhsaa.violations(p, weather(5))) == ["zone5_no_outdoor_activity"] * 2


def test_three_hour_cap():
    p = plan(drill("a", 200, gear="none"), start="2026-10-04T08:00:00-04:00")
    assert "max_single_practice" in rules(fhsaa.violations(p, weather(1, 1, 1, 1, start_hour=8)))


def test_cooling_zone_only_when_explicitly_missing():
    p = plan(*[x for i in range(5) for x in (drill(f"d{i}", 8), drill(f"b{i}", 4, brk=True, shade=True))],
             start="2026-10-04T15:00:00-04:00")
    assert "cooling_zone_required" not in rules(fhsaa.violations(p, weather(2, 2)))
    assert "cooling_zone_confirm" in rules(fhsaa.advisories(p, weather(2, 2)))
    p["site"]["cooling_zone"] = False
    assert "cooling_zone_required" in rules(fhsaa.violations(p, weather(2, 2)))
    p["site"]["cooling_zone"] = True
    assert fhsaa.advisories(p, weather(2, 2)) and "cooling_zone_confirm" not in rules(fhsaa.advisories(p, weather(2, 2)))


def test_acclimatization_gear():
    p = plan(drill("a", 10, gear="full_pads"), drill("b", 10, gear="helmet_shoulder_pads"), drill("c", 10, gear="helmet"))
    roster = [{"id": "d2", "acclimatization_day": 2}, {"id": "d4", "acclimatization_day": 4}, {"id": "d6", "acclimatization_day": 6}]
    hits = {(v["drill_id"], v["detail"].split()[0]) for v in fhsaa.acclimatization_violations(p, roster)}
    assert hits == {("a", "d2"), ("b", "d2"), ("a", "d4")}


def test_demo_plan_output_shape():
    v = fhsaa.violations(fixtures.plan(), fixtures.forecast())
    assert all(set(x) == {"drill_id", "rule", "detail"} for x in v)
