"""NATA 2009 per-athlete gear phasing: limits, violations, physics uses per-athlete gear, optimizer repairs."""
from __future__ import annotations

import copy

from engine import fhsaa_adapter, fixtures, gear_rules
from engine.optimizer import optimize
from engine.physio.twonode import simulate_roster


def test_limits_follow_nata_phases():
    assert gear_rules.nata_limit(1) == gear_rules.nata_limit(2) == "helmet"
    assert gear_rules.nata_limit(3) == gear_rules.nata_limit(5) == "helmet_shoulder_pads"
    assert gear_rules.nata_limit(6) == gear_rules.nata_limit(20) == "full_pads"
    # explicit limit can tighten but never loosen
    assert gear_rules.athlete_gear_limit({"acclimatization_day": 8, "gear_limit": "helmet"}) == "helmet"
    assert gear_rules.athlete_gear_limit({"acclimatization_day": 2, "gear_limit": "full_pads"}) == "helmet"


def test_fixtures_comply():
    plan, roster = fixtures.plan(), fixtures.roster()
    assert gear_rules.phasing_violations(plan, roster) == []
    for a in roster:
        assert a["gear_limit"] == gear_rules.nata_limit(a["acclimatization_day"])


def _uncapped_plan():
    plan = fixtures.plan()
    for d in plan["drills"]:
        d.pop("gear_by_athlete", None)
    return plan


def test_gear_above_limit_is_a_violation():
    v = fhsaa_adapter.violations(_uncapped_plan(), fixtures.forecast(), fixtures.roster())
    phasing = [x for x in v if x["rule"] == gear_rules.RULE]
    assert {x["drill_id"] for x in phasing} == {"d2", "b1", "d3", "d4", "b2", "d5"}
    assert "Devin (fictional) (day 2: full pads > helmet only)" in phasing[0]["detail"]
    # participants not in the drill are not checked
    plan = _uncapped_plan()
    plan["drills"][1]["participants"] = ["a05", "a09"]
    assert "d2" not in {x["drill_id"] for x in gear_rules.phasing_violations(plan, fixtures.roster())}


def test_physics_uses_per_athlete_gear():
    """Capped (lighter) gear for day-2 athletes must not make them hotter than the uncapped plan."""
    roster, w = fixtures.roster(), fixtures.forecast()
    capped = simulate_roster(roster, fixtures.plan(), w, n_ensemble=5)
    uncapped = simulate_roster(roster, _uncapped_plan(), w, n_ensemble=5)
    for a, b in zip(capped["athletes"], uncapped["athletes"]):
        assert a["peak_core_c_p95"] <= b["peak_core_c_p95"] + 1e-9
    assert any(v["rule"] == gear_rules.RULE for v in uncapped["fhsaa_violations"])
    assert not any(v["rule"] == gear_rules.RULE for v in capped["fhsaa_violations"])


def test_optimizer_repairs_phasing():
    roster = [a for a in fixtures.roster() if a["id"] in ("a02", "a10", "a09", "a14")]
    plan = _uncapped_plan()
    res = optimize(plan, roster, fixtures.forecast(), n_ensemble=10, budget_s=60, max_iterations=60, seed=0)
    assert not any(v["rule"] == gear_rules.RULE for v in res["optimized"]["fhsaa_violations"])
    assert any(c["move"] in ("gear_per_athlete", "gear_down") for c in res["changes"])
