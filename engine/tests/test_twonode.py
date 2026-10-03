"""twonode-v1 physics and contract tests (MODEL.md §12)."""
from __future__ import annotations

import copy
import time

import numpy as np
import pytest

from engine import consts, fixtures
from engine.physio import twonode
from engine.physio.twonode import integrate, psat_mmhg, simulate_roster

LIMIT_LOW, LIMIT_HIGH = 36.0, 42.0


def _const_integrate(*, met, tdb, tr, v, rh, clo, minutes, dt_s=60.0, mass=70.0, bsa=1.8258,
                     cap_mode="ashrae55_reference"):
    """Single athlete, constant conditions, Gagge's own clothing evaporative law (i_cl)."""
    g = consts.get("gagge_1986")
    S = int(round(minutes * 60.0 / dt_s))
    r_cl = g["clo_to_m2k_w"] * clo
    clothed = clo > 0
    r_ecl = r_cl / (g["lewis_ratio_k_mmhg"] * (g["icl_clothed"] if clothed else g["icl_nude"]))
    one = np.ones((1, S))
    return integrate(
        met_wm2=met * g["met_factor_w_m2"] * one, met_scale=np.ones((1, 1)),
        ta=np.full(S, float(tdb)), pa=np.full(S, rh / 100.0 * psat_mmhg(tdb)), v=np.full(S, float(v)),
        tr=tr * one, r_cl=r_cl * one, r_ecl=r_ecl * one, f_cl=(1 + g["fcl_per_clo"] * clo) * one,
        clothed=np.full((1, S), clothed), mass_kg=np.array([mass]), bsa_m2=np.array([bsa]), dt_s=dt_s,
        record_every=max(1, int(round(60.0 / dt_s))), cap_mode=cap_mode,
    )


# ── agreement with the reference implementation ─────────────────────────────

REF_CASES = [  # tdb, tr, v, rh, met, clo — comfort, warm, hot-humid, exercise
    (25, 25, 0.1, 50, 1.2, 0.5),
    (30, 30, 0.3, 60, 3.0, 0.6),
    (35, 45, 0.5, 50, 6.0, 1.0),
    (38, 38, 0.2, 40, 4.0, 0.0),
    (30, 50, 2.0, 80, 10.0, 0.8),
    (28, 28, 0.1, 50, 1.0, 0.0),
]
REF_TOL_C = 0.01  # stated tolerance: ≤ 0.01 °C core and skin after 59 min


@pytest.mark.parametrize("case", REF_CASES)
def test_matches_pythermalcomfort_two_nodes_gagge(case):
    from pythermalcomfort.models import two_nodes_gagge

    tdb, tr, v, rh, met, clo = case
    ref = two_nodes_gagge(tdb=tdb, tr=tr, v=v, rh=rh, met=met, clo=clo, round_output=False)
    out = _const_integrate(met=met, tdb=tdb, tr=tr, v=v, rh=rh, clo=clo,
                           minutes=consts.get("gagge_1986.reference_sim_minutes"),
                           mass=consts.get("gagge_1986.reference_body_mass_kg"),
                           bsa=consts.get("gagge_1986.reference_bsa_m2"))
    assert out.core[0, 0, -1] == pytest.approx(float(ref.t_core), abs=REF_TOL_C)
    assert out.skin[0, 0, -1] == pytest.approx(float(ref.t_skin), abs=REF_TOL_C)
    assert out.tcl_max_residual <= consts.get("gagge_1986.tcl_tolerance_k")


def test_consistent_cap_is_never_cooler_than_reference():
    """Default cap mode lets less sweat evaporate at the wettedness cap → core ≥ reference mode."""
    for tdb, tr, v, rh, met, clo in REF_CASES:
        a = _const_integrate(met=met, tdb=tdb, tr=tr, v=v, rh=rh, clo=clo, minutes=59, cap_mode="ashrae55_reference")
        b = _const_integrate(met=met, tdb=tdb, tr=tr, v=v, rh=rh, clo=clo, minutes=59, cap_mode="consistent")
        assert b.core[0, 0, -1] >= a.core[0, 0, -1] - 1e-9


# ── sanity on synthetic constant scenarios ──────────────────────────────────

def test_core_rises_with_met():
    peaks = [_const_integrate(met=m, tdb=30, tr=40, v=1.0, rh=60, clo=1.0, minutes=30).core[0, 0, -1]
             for m in (1.5, 3.0, 5.0, 8.0)]
    assert np.all(np.diff(peaks) > 0), peaks


def test_core_falls_at_rest_in_shade_after_work():
    """Hard work in sun, then rest in shade (MRT = air temp): core must fall during rest."""
    g = consts.get("gagge_1986")
    S_work, S_rest = 30, 20
    S = S_work + S_rest
    met = np.r_[np.full(S_work, 8.0), np.full(S_rest, 1.2)] * g["met_factor_w_m2"]
    tr = np.r_[np.full(S_work, 45.0), np.full(S_rest, 30.0)]
    r_cl = g["clo_to_m2k_w"] * 0.6
    out = integrate(
        met_wm2=met[None, :], met_scale=np.ones((1, 1)), ta=np.full(S, 30.0),
        pa=np.full(S, 0.5 * psat_mmhg(30.0)), v=np.full(S, 1.0), tr=tr[None, :],
        r_cl=np.full((1, S), r_cl), r_ecl=np.full((1, S), r_cl / (g["lewis_ratio_k_mmhg"] * g["icl_clothed"])),
        f_cl=np.full((1, S), 1 + g["fcl_per_clo"] * 0.6), clothed=np.ones((1, S), bool),
        mass_kg=np.array([90.0]), bsa_m2=np.array([2.1]), dt_s=60.0)
    core = out.core[0, 0]
    assert core[S_work - 1] > core[0]
    rest = core[S_work + 2:]
    assert np.all(np.diff(rest) < 0), "core should fall monotonically after a short lag at rest in shade"
    assert core[-1] < core[S_work - 1]


def _fixture_with(weather_patch=None, drills_patch=None):
    roster, plan, weather = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    weather = copy.deepcopy(weather)
    for h in weather:
        if weather_patch:
            weather_patch(h)
    if drills_patch:
        drills_patch(plan["drills"])
    return roster, plan, weather


def _peak_p50(res):
    return np.array([a["core_c_p50"] for a in res["athletes"]]).max(axis=1)


@pytest.mark.parametrize("key,deltas", [
    ("air_temp_c", (-4.0, -2.0, 0.0, 2.0)),
    ("rh_pct", (-30.0, -15.0, 0.0, 10.0)),
])
def test_monotonic_in_heat_stress(key, deltas):
    """Raising air temperature or humidity (each raises WBGT) raises every athlete's peak core estimate."""
    peaks = []
    for d in deltas:
        def patch(h, d=d):
            h[key] = min(h[key] + d, 100.0) if key == "rh_pct" else h[key] + d
        roster, plan, weather = _fixture_with(patch)
        peaks.append(_peak_p50(simulate_roster(roster, plan, weather, n_ensemble=5)))
    peaks = np.array(peaks)
    assert np.all(np.diff(peaks, axis=0) > 0), peaks


def test_monotonic_in_solar():
    """More sun (less cloud → higher GHI → higher globe temp and WBGT) raises core estimates."""
    peaks = []
    for cloud in (100.0, 60.0, 20.0, 0.0):
        def patch(h, c=cloud):
            h["cloud_cover_pct"] = c
            h.pop("solar_w_m2", None)
        roster, plan, weather = _fixture_with(patch)
        peaks.append(_peak_p50(simulate_roster(roster, plan, weather, n_ensemble=5)))
    assert np.all(np.diff(np.array(peaks), axis=0) > 0)


def test_bounded_on_fixtures():
    res = simulate_roster(fixtures.roster(), fixtures.plan(), fixtures.forecast())
    for a in res["athletes"]:
        for series in (a["core_c_p50"], a["core_c_p95"]):
            assert LIMIT_LOW <= min(series) and max(series) <= LIMIT_HIGH, (a["id"], min(series), max(series))


def test_step_15s_matches_1min():
    """Cutting the step to 15 s changes no athlete's core estimate by more than 0.05 °C at any shared minute."""
    roster, plan, weather = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    a = simulate_roster(roster, plan, weather, step_min=1, n_ensemble=10)
    b = simulate_roster(roster, plan, weather, step_min=0.25, n_ensemble=10)
    for x, y in zip(a["athletes"], b["athletes"]):
        p50_1, p50_q = np.array(x["core_c_p50"]), np.array(y["core_c_p50"])[3::4]
        p95_1, p95_q = np.array(x["core_c_p95"]), np.array(y["core_c_p95"])[3::4]
        assert np.max(np.abs(p50_1 - p50_q)) < 0.05
        assert np.max(np.abs(p95_1 - p95_q)) < 0.05


def test_state_carries_across_drills():
    """Inserting a long shaded rest in the middle must lower the core estimate in the following drill."""
    roster, plan, weather = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    base = simulate_roster(roster, plan, weather, n_ensemble=5)
    plan2 = copy.deepcopy(plan)
    plan2["drills"].insert(4, {"id": "rest", "name": "rest", "duration_min": 15, "intensity": "rest",
                               "gear": "none", "shade": True, "is_break": True, "priority": 1, "movable": True})
    alt = simulate_roster(roster, plan2, weather, n_ensemble=5)
    t_before = 10 + 20 + 4 + 15  # end of d3 in both plans
    for x, y in zip(base["athletes"], alt["athletes"]):
        assert y["core_c_p50"][t_before + 15 - 1] < x["core_c_p50"][t_before - 1] + 1e-9


# ── contract shape and labels ────────────────────────────────────────────────

def test_simulation_result_shape_and_labels():
    res = simulate_roster(fixtures.roster(), fixtures.plan(), fixtures.forecast(), extra_labels=["synthetic roster"])
    T = int(sum(d["duration_min"] for d in fixtures.plan()["drills"]))
    assert len(res["times"]) == T
    assert res["model"]["name"] == "twonode-v1"
    assert twonode.ESTIMATE_LABEL in res["labels"]
    assert "forecast is fixture" in res["labels"]
    for a in res["athletes"]:
        assert len(a["core_c_p50"]) == T and len(a["core_c_p95"]) == T
        assert a["status"] in ("below_limit", "near_limit", "over_limit")
        assert all(q >= p - 1e-9 for p, q in zip(a["core_c_p50"], a["core_c_p95"]))
    text = repr(res).lower()
    assert "safe" not in text


def test_deterministic_with_seed():
    r = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    a = simulate_roster(*r, seed=3)
    b = simulate_roster(*r, seed=3)
    assert a["athletes"] == b["athletes"]


# ── performance ─────────────────────────────────────────────────────────────

def test_performance_16x113x30_under_50ms():
    roster, plan, weather = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    R = twonode.build_roster(roster)
    tl = twonode.build_timeline(plan["drills"], R.ids, 1.0)
    env = twonode.build_environment(weather, plan["site"], twonode.parse_time(plan["start"]), 1.0, tl.n_steps)
    D = twonode.make_draws(30, len(R.ids), 0)
    twonode.simulate_arrays(tl, env, R, D)  # warm-up
    best = min(_timed(lambda: twonode.simulate_arrays(tl, env, R, D)) for _ in range(5))
    assert tl.n_steps == 113 and len(R.ids) == 16
    assert best < 0.050, f"{best * 1000:.1f} ms"


def _timed(fn):
    t = time.perf_counter()
    fn()
    return time.perf_counter() - t
