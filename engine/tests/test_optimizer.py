"""WS4 optimizer tests on synthetic fixtures (fixtures/optimizer/*.json, labelled synthetic) and the demo fixture."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from engine import consts, fixtures
from engine.optimizer import optimize

FX = Path(__file__).resolve().parents[2] / "fixtures" / "optimizer"
FAST = dict(n_ensemble=10, budget_s=60.0, max_iterations=120, seed=0)


def _load(name):
    fx = json.loads((FX / f"{name}.json").read_text())
    assert fx["synthetic"] is True
    by_id = {a["id"]: a for a in fixtures.roster()}
    return fx["plan"], [by_id[i] for i in fx["roster_ids"]], fx["weather"]


def _check_contract(res):
    for key in ("original", "optimized", "plan", "changes", "load_kept_pct", "feasible", "search"):
        assert key in res
    for key in ("iterations", "seconds", "method"):
        assert key in res["search"]
    kinds = {"reorder", "insert_break", "gear_change", "trim", "shade"}
    assert all(c["kind"] in kinds and c["drill_id"] and c["detail"] for c in res["changes"])
    assert "estimate — planning only" in res["labels"]
    assert "safe" not in json.dumps(res).lower()


def _non_movable_in_place(orig_plan, new_plan):
    orig = [d["id"] for d in orig_plan["drills"]]
    new_src = [d["id"].split(".")[0] for d in new_plan["drills"] if not d["id"].startswith("ib")]
    for d in orig_plan["drills"]:
        if not d["movable"]:
            before_o = set(orig[: orig.index(d["id"])])
            i = new_src.index(d["id"])
            assert set(new_src[:i]) <= before_o and not (set(new_src[i + 1:]) & before_o)


def _p1_kept(orig_plan, new_plan):
    frac = consts.get("optimizer.p1_min_kept_fraction")
    for d in orig_plan["drills"]:
        if d["priority"] == 1 and not d["is_break"]:
            kept = sum(x["duration_min"] for x in new_plan["drills"] if x["id"].split(".")[0] == d["id"])
            assert kept >= frac * d["duration_min"] - 1e-9, d["id"]


def test_fixed_by_reordering_only():
    plan, roster, weather = _load("reorder_only")
    res = optimize(plan, roster, weather, **FAST)
    _check_contract(res)
    assert res["original"]["fhsaa_violations"] == []
    assert any(a["status"] == "over_limit" for a in res["original"]["athletes"])
    assert res["feasible"] is True
    assert res["changes"] and {c["kind"] for c in res["changes"]} == {"reorder"}
    assert res["load_kept_pct"] == pytest.approx(100.0)
    assert all(a["peak_core_c_p95"] < res["optimized"]["limit_core_c"] for a in res["optimized"]["athletes"])
    _non_movable_in_place(plan, res["plan"])


def test_needs_a_break():
    plan, roster, weather = _load("needs_break")
    res = optimize(plan, roster, weather, **FAST)
    _check_contract(res)
    assert res["original"]["fhsaa_violations"], "fixture must start with a break violation"
    assert res["feasible"] is True
    assert res["optimized"]["fhsaa_violations"] == []
    assert any(c["kind"] == "insert_break" for c in res["changes"])
    added = [d for d in res["plan"]["drills"] if d["is_break"]]
    assert added and all(d["shade"] for d in added)
    _non_movable_in_place(plan, res["plan"])
    _p1_kept(plan, res["plan"])


def test_zone5_is_infeasible_and_returns_least_bad_plan():
    plan, roster, weather = _load("zone5")
    res = optimize(plan, roster, weather, **FAST)
    _check_contract(res)
    assert res["feasible"] is False
    assert res["plan"]["drills"], "least-bad plan must still be returned"
    assert any("zone 5" in r.lower() for r in res["infeasible_reasons"])
    assert any("least-bad" in lab for lab in res["labels"])
    _non_movable_in_place(plan, res["plan"])
    _p1_kept(plan, res["plan"])


def test_deterministic_with_fixed_seed():
    plan, roster, weather = _load("needs_break")
    kw = dict(FAST, seed=7)
    a = optimize(plan, roster, weather, **kw)
    b = optimize(plan, roster, weather, **kw)
    assert a["search"]["stopped_by"] == "iterations" and b["search"]["stopped_by"] == "iterations"
    assert a["plan"] == b["plan"] and a["changes"] == b["changes"] and a["load_kept_pct"] == b["load_kept_pct"]


@pytest.mark.slow
def test_demo_fixture_reaches_a_compliant_plan():
    """Real fixture plan + cached NWS forecast: all constraints met within the default budget."""
    plan, roster, weather = fixtures.plan(), fixtures.roster(), fixtures.forecast()
    res = optimize(plan, roster, weather, seed=0)
    _check_contract(res)
    assert res["feasible"] is True
    assert res["optimized"]["fhsaa_violations"] == []
    assert all(a["peak_core_c_p95"] < res["optimized"]["limit_core_c"] for a in res["optimized"]["athletes"])
    assert res["search"]["seconds"] <= consts.get("optimizer.default_budget_s") + 2.0
    _non_movable_in_place(plan, res["plan"])
    _p1_kept(plan, res["plan"])
    total = sum(d["duration_min"] for d in res["plan"]["drills"])
    assert total <= sum(d["duration_min"] for d in plan["drills"]) + consts.get("optimizer.max_added_minutes")


def test_fewest_changes_preset_caps_changes():
    plan, roster, weather = _load("needs_break")
    res = optimize(plan, roster, weather, preset="fewest_changes", **FAST)
    cap = consts.get("optimizer_presets.fewest_changes.max_changes")
    assert res["search"]["preset"] == "fewest_changes" and res["search"]["max_changes"] == cap
    if res["feasible"]:
        assert len(res["changes"]) <= cap
    else:
        assert any("changes" in r for r in res["infeasible_reasons"]) or res["infeasible_reasons"]
    with pytest.raises(ValueError):
        optimize(plan, roster, weather, preset="bogus", **FAST)


def test_change_cap_never_outranks_a_rule():
    """Reviewer bug 3: tiers — a plan over the change cap but rule-compliant beats a rule-violating plan within it."""
    import numpy as np
    from engine.optimizer import Eval
    common = dict(state=(), violations=[], peak_p95=np.zeros(1), first_cross_step=np.zeros(1), energy=0.0, at_risk=())
    over_cap = Eval(feasible=False, infeas=1.0, load_w=50.0, n_changes=7, infeas_cap=1.0, **common)
    breaks_rule = Eval(feasible=False, infeas=0.5, load_w=90.0, n_changes=5, infeas_rules=0.5, **common)
    assert over_cap.rank() < breaks_rule.rank()


def test_top_changes_ranked_by_heat_reduction():
    plan, roster, weather = _load("reorder_only")
    res = optimize(plan, roster, weather, **FAST)
    top = res["top_changes"]
    assert len(top) <= consts.get("optimizer.top_changes_k")
    assert all(t["heat_reduction_c"] > 0 for t in top)
    assert [t["heat_reduction_c"] for t in top] == sorted((t["heat_reduction_c"] for t in top), reverse=True)
    assert res["top_changes_text"].endswith("Estimate — planning only.")


def test_fewest_changes_steps_the_cap_to_the_minimum_compliant_edit(monkeypatch):
    """Decision 4: when the preset cap is too small, raise it one step at a time and return the first compliant plan
    (needs at least N changes) instead of falling back to max_load."""
    plan, roster, weather = _load("needs_break")
    presets = dict(consts.get("optimizer_presets"))
    presets["fewest_changes"] = {"max_changes": 0}       # 0 changes can't fix a plan that needs a break
    real_get = consts.get
    monkeypatch.setattr(consts, "get", lambda k, *a: presets if k == "optimizer_presets" else real_get(k, *a))
    res = optimize(plan, roster, weather, preset="fewest_changes", **FAST)
    fc = res["fewest_changes"]
    assert fc["cap"] == 0 and fc["searched_caps"][0] == 0
    if not fc["fell_back"]:
        n = fc["min_compliant_changes"]
        assert res["feasible"] and len(res["changes"]) <= n and fc["searched_caps"] == list(range(0, n + 1))
        assert any(f"needs at least {n} changes" in x for x in res["labels"])
        assert not any("showing the max_load plan" in x for x in res["labels"])


def test_demo_max_load_returns_the_best_compliant_plan_including_the_minimum_edit_seed():
    """Decision 4 (Oct 3): demo max_load also seeds from the minimum compliant edit and keeps the best compliant plan
    by load kept (tie-break fewer changes); the label lists every candidate."""
    plan, roster, weather = _load("needs_break")
    res = optimize(plan, roster, weather, demo=True, preset="max_load")
    note = [x for x in res["labels"] if x.startswith("max_load: best compliant plan")]
    if res["feasible"] and note:
        import re
        kept = [float(k) for k in re.findall(r"(\d+\.\d)% / \d+ changes", note[0])]
        assert res["load_kept_pct"] == max(kept)
