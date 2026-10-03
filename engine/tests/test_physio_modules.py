"""metabolic.py, clothing.py, radiation.py and jos3_ref.py."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pytest

from engine import consts, fixtures
from engine.physio import clothing, jos3_ref, metabolic, radiation


# ── metabolic ───────────────────────────────────────────────────────────────

def test_intensity_met_is_monotonic_and_from_constants():
    mets = [metabolic.intensity_met(i) for i in metabolic.INTENSITIES]
    assert mets == sorted(mets)
    assert mets == [consts.get(f"drill_met.values.{i}.met") for i in metabolic.INTENSITIES]


def test_met_override_wins():
    assert metabolic.drill_met({"intensity": "hard", "met_override": 5.5}) == 5.5


def test_met_to_w_m2_scales_with_mass_per_area():
    """Mass-specific METs: a heavier athlete per unit area produces more heat per m² at the same MET."""
    big = metabolic.met_to_w_m2(8.0, 132.0, metabolic.body_surface_area_m2(132.0, 1.90))
    small = metabolic.met_to_w_m2(8.0, 77.0, metabolic.body_surface_area_m2(77.0, 1.80))
    assert big > small
    # 1 MET = 1 kcal/kg/h → 1.1622 W/kg
    assert metabolic.w_per_kg_per_met() == pytest.approx(4184.0 / 3600.0)


def test_dubois_matches_pythermalcomfort():
    from pythermalcomfort.utilities import body_surface_area
    assert metabolic.body_surface_area_m2(70.0, 1.75) == pytest.approx(body_surface_area(70.0, 1.75))


def test_hr_to_met_endpoints():
    hr_max = metabolic.hr_max_bpm(17)
    assert hr_max == pytest.approx(208 - 0.7 * 17)
    assert metabolic.met_from_hr(60, 60, hr_max, 42.0) == pytest.approx(1.0)
    assert metabolic.met_from_hr(hr_max, 60, hr_max, 42.0) == pytest.approx(42.0 / 3.5)
    mid = metabolic.met_from_hr(60 + 0.5 * (hr_max - 60), 60, hr_max, 42.0)
    assert mid == pytest.approx(0.5 * (1 + 42.0 / 3.5))


# ── clothing ────────────────────────────────────────────────────────────────

def test_gear_resistance_ordering():
    p = {g: clothing.gear_props(g) for g in clothing.GEAR_LEVELS}
    assert p["none"].i_t_m2k_w < p["helmet_shoulder_pads"].i_t_m2k_w < p["full_pads"].i_t_m2k_w
    assert p["none"].r_ecl_m2mmhg_w < p["helmet_shoulder_pads"].r_ecl_m2mmhg_w < p["full_pads"].r_ecl_m2mmhg_w
    assert p["none"].i_m > p["full_pads"].i_m


def test_iso_dynamic_correction_reduces_resistance_with_wind_and_work():
    from engine.physio.twonode import iso_dynamic_resistances, iso_params
    g = clothing.gear_props("full_pads")
    Q = iso_params()
    still = iso_dynamic_resistances(np.array(58.0), 0.0, g.i_t_m2k_w, g.i_m, g.i_cl_clo, g.f_cl, Q)[1]
    windy = iso_dynamic_resistances(np.array(58.0), 2.0, g.i_t_m2k_w, g.i_m, g.i_cl_clo, g.f_cl, Q)[1]
    working = iso_dynamic_resistances(np.array(400.0), 2.0, g.i_t_m2k_w, g.i_m, g.i_cl_clo, g.f_cl, Q)[1]
    assert working < windy < still
    # still air, no walking: corr = min(1.044, 1) = 1 → static R_e,T = I_T / (i_m · 16.7) [kPa] → mmHg
    static_kpa = g.i_t_m2k_w / (min(g.i_m * (2.6 - 6.5 + 4.9), 0.9) * 16.7)
    assert float(still) == pytest.approx(static_kpa * 1000.0 / consts.get("physical.pa_per_mmhg"), rel=1e-6)


# ── radiation ───────────────────────────────────────────────────────────────

def _ts(*args):
    return datetime(*args, tzinfo=timezone.utc).timestamp()


def test_solar_noon_elevation_gainesville():
    """Max elevation ≈ 90 − lat + declination (NOAA declination at that date) within 0.3°."""
    lat, lon = 29.6516, -82.3248
    ts = np.array([_ts(2026, 10, 4, 15, 0) + 60 * k for k in range(240)])
    elev = radiation.solar_elevation_deg(ts, lat, lon)
    g = 2 * np.pi / 365 * (277 - 1 + (17.5 - 12) / 24)
    c = consts.get("solar_position.decl_coeffs")
    decl = np.degrees(c[0] + c[1] * np.cos(g) + c[2] * np.sin(g) + c[3] * np.cos(2 * g) + c[4] * np.sin(2 * g)
                      + c[5] * np.cos(3 * g) + c[6] * np.sin(3 * g))
    assert elev.max() == pytest.approx(90 - lat + decl, abs=0.3)
    night = radiation.solar_elevation_deg(np.array([_ts(2026, 10, 4, 6, 0)]), lat, lon)
    assert night[0] < 0


def test_erbs_split_conserves_ghi():
    ts = np.array([_ts(2026, 10, 4, 18, 0)])
    elev = radiation.solar_elevation_deg(ts, 29.65, -82.32)
    for ghi in (100.0, 400.0, 800.0):
        i_dir, i_diff = radiation.split_direct_diffuse(np.array([ghi]), ts, elev)
        assert i_dir[0] * np.sin(np.radians(elev[0])) + i_diff[0] == pytest.approx(ghi, rel=1e-9)


@pytest.mark.parametrize("alt,i_dir", [(20.0, 600.0), (45.0, 800.0), (70.0, 900.0)])
def test_solarcal_matches_pythermalcomfort_solar_gain(alt, i_dir):
    """Same equation as pythermalcomfort.solar_gain when fed its fixed diffuse (0.2·I_dir) and averaged over SHARP."""
    from pythermalcomfort.models import solar_gain
    sc = consts.get("solarcal")
    rho = 0.23
    sharps = np.array(sc["fp_az_grid_deg"], dtype=float)
    ref = np.mean([solar_gain(sol_altitude=alt, sharp=sh, sol_radiation_dir=i_dir, sol_transmittance=1, f_svv=1,
                              f_bes=1, asw=sc["alpha_sw"], posture="standing", floor_reflectance=rho,
                              round_output=False).delta_mrt for sh in sharps])
    alt_grid = np.array(sc["fp_alt_grid_deg"], dtype=float)
    tab = np.array(sc["fp_table_standing"], dtype=float)
    fp = np.mean([np.interp(alt, alt_grid, row) for row in tab])  # same grid → plain mean over the 13 SHARP rows
    i_diff = 0.2 * i_dir
    ghi = i_dir * np.sin(np.radians(alt)) + i_diff
    ours = radiation.solarcal_delta_mrt(i_dir, i_diff, ghi, fp, rho)
    # pythermalcomfort uses h_r = 6; constants use 6.012 (ASHRAE 55 via ladybug)
    assert float(ours) == pytest.approx(ref * 6.0 / sc["h_r_w_m2_k"], rel=1e-6)


def test_wind_profile_reduces_10m_wind():
    v = radiation.wind_at_body(np.array([0.0, 2.0, 5.0]))
    assert v[0] == consts.get("gagge_1986.min_air_speed_m_s")
    assert 0 < v[1] < 2.0 and v[2] < 5.0


# ── JOS-3 cross-check runs and reports a gap ─────────────────────────────────

def test_jos3_crosscheck_reports_gap():
    rep = jos3_ref.compare(fixtures.roster(), fixtures.plan(), fixtures.forecast(), athlete_ids=["a02", "a11"])
    assert {r["id"] for r in rep["athletes"]} == {"a02", "a11"}
    for r in rep["athletes"]:
        assert len(r["jos3_core_c"]) == len(r["twonode_core_c"]) == 113
        assert 36.0 < max(r["jos3_core_c"]) < 44.0
        assert np.isfinite(r["rmse_c"])
    assert "model cross-check, not a validation against measured data" in rep["labels"]


def test_exact_mrt_delivers_the_solarcal_field():
    """T_r from the linear SolarCal ΔMRT must make σ·(T_r⁴ − T_a⁴) = h_r·ΔMRT (exact radiation, reviewer B1)."""
    sc, ph = consts.get("solarcal"), consts.get("physical")
    ta, dlin = np.array([30.0, 31.0]), np.array([20.0, 36.0])
    tr = radiation.mrt_from_linear_delta(ta, dlin)
    k = ph["kelvin_offset"]
    lhs = ph["stefan_boltzmann_w_m2_k4"] * ((tr + k) ** 4 - (ta + k) ** 4)
    assert np.allclose(lhs, sc["h_r_w_m2_k"] * dlin)
    assert np.all(tr - ta < dlin)  # hotter radiant field → smaller exact ΔMRT than the linear one


def test_unverified_gear_level_is_labelled():
    """The plan uses 'helmet', whose clothing values are TODO — the label must say so (reviewer B3)."""
    from engine.physio.twonode import simulate_roster
    res = simulate_roster(fixtures.roster()[:2], fixtures.plan(), fixtures.forecast(), n_ensemble=5)
    assert any("gear_clothing.levels.helmet (TODO)" in lab for lab in res["labels"])


def test_conservative_calibration_reproduces_armstrong_full():
    """constants.clothing_conservative.δ must still reproduce its Armstrong 2010 FULL target (recalibrate if not)."""
    from validation.armstrong_2010 import simulate
    metric = consts.get("clothing_conservative.calibration_metric")
    sim = simulate("FULL", "conservative")
    if metric == "whole_rise":
        assert sim["rise_c"] == pytest.approx(consts.get("armstrong_2010.rise_c.FULL")[0], abs=0.01)
    else:
        assert sim["treadmill_rate_c_per_min"] == pytest.approx(consts.get("armstrong_2010.treadmill_rate_c_per_min.FULL")[0], abs=5e-4)
    # conservative never heats less than the ISO-dynamic alternate
    for cond in ("CON", "FULL"):
        assert simulate(cond, "conservative")["treadmill_rate_c_per_min"] >= simulate(cond, "iso7933_dynamic")["treadmill_rate_c_per_min"]


def test_results_json_is_computed_by_validation_code():
    import json
    from pathlib import Path
    res = json.loads((Path(__file__).resolve().parents[2] / "validation" / "results.json").read_text())["armstrong_2010"]
    assert res["computed_by"] == "validation/armstrong_2010.py" and res["synthetic"] is False
    assert {r["clothing_mode"] for r in res["rows"]} == {"conservative", "iso7933_dynamic", "gagge_static", "jos3"}
    assert "summary values only" in res["comparison_basis"]


@pytest.mark.parametrize("mode", ["conservative", "iso7933_dynamic", "gagge_static"])
def test_numba_kernel_matches_numpy(mode, monkeypatch):
    """The compiled kernel and the numpy reference loop give the same core temperatures (≤ 2e-3 °C)."""
    from engine.physio import twonode
    if twonode._numba_kernel() is None:
        pytest.skip("numba unavailable")
    roster, plan, w = fixtures.roster(), fixtures.plan(), fixtures.forecast()
    R = twonode.build_roster(roster)
    tl = twonode.build_timeline(plan["drills"], R.ids, 1.0)
    env = twonode.build_environment(w, plan["site"], twonode.parse_time(plan["start"]), 1.0, tl.n_steps)
    D = twonode.make_draws(8, len(R.ids), 0)
    fast = twonode.simulate_arrays(tl, env, R, D, clothing_mode=mode).core
    orig = twonode.integrate
    monkeypatch.setattr(twonode, "integrate", lambda **kw: orig(**kw, backend="numpy"))
    ref = twonode.simulate_arrays(tl, env, R, D, clothing_mode=mode).core
    assert np.max(np.abs(fast - ref)) < 2e-3


def test_surcharge_weights_per_gear_level():
    """Reviewer bug 2: helmet-only (which borrows P2 clothing values) gets no extra surcharge; full pads get δ."""
    from engine.physio import twonode
    sc = dict(zip(clothing.GEAR_LEVELS, twonode.gear_met_surcharge()))
    assert sc["none"] == 0.0 and sc["helmet"] == 0.0
    assert sc["full_pads"] == pytest.approx(consts.get("clothing_conservative.gear_met_surcharge_full_pads"))
    assert 0 < sc["helmet_shoulder_pads"] < sc["full_pads"]


def test_rotated_out_athletes_capped_at_their_gear_limit():
    """Reviewer bug 4: a day-2 athlete rotated out of a full-pads drill is modelled at most in a helmet."""
    from engine.physio import twonode
    roster = [a for a in fixtures.roster() if a["id"] in ("a06", "a14")]  # day 2 (helmet), day 12 (full pads)
    drill = {"id": "x", "name": "x", "duration_min": 5, "intensity": "hard", "gear": "full_pads", "shade": False,
             "is_break": False, "priority": 1, "movable": True, "participants": ["a14"]}
    tl = twonode.build_timeline([drill], [a["id"] for a in roster], 1.0, gear_cap=twonode.gear_caps(roster))
    assert clothing.GEAR_LEVELS[tl.gear[0, 0]] == "helmet" and clothing.GEAR_LEVELS[tl.gear[1, 0]] == "full_pads"


def test_walk_credit_choice_matches_validation():
    """Owner decision 2: the walking-ventilation credit in constants is the one that better reproduces Armstrong CON
    with the ACSM treadmill MET."""
    from validation.armstrong_2010 import walk_credit_check
    chk = walk_credit_check()
    assert chk["in_constants"] == chk["chosen_walk_credit"]
    assert chk["treadmill_met_acsm"] == pytest.approx(6.067, abs=1e-3)


def test_field_plausibility_results_present():
    import json
    from pathlib import Path
    res = json.loads((Path(__file__).resolve().parents[2] / "validation" / "results.json").read_text())["field_plausibility"]
    assert res["computed_by"] == "validation/field_plausibility.py" and res["synthetic"] is False
    assert len(res["scenarios"]) >= 5 and res["sensitivity_demo"][0]["case"].startswith("baseline")


def test_concurrent_simulations_do_not_crash():
    """Reviewer bug 1: parallel numba kernel entered from several threads (uvicorn thread pool) must not abort."""
    from concurrent.futures import ThreadPoolExecutor
    from engine.physio.twonode import simulate_roster
    args = (fixtures.roster()[:4], fixtures.plan(), fixtures.forecast())
    with ThreadPoolExecutor(max_workers=6) as ex:
        outs = list(ex.map(lambda _: simulate_roster(*args, n_ensemble=10), range(12)))
    assert all(o["athletes"] == outs[0]["athletes"] for o in outs)


def test_drill_type_inference():
    types = {d["id"]: metabolic.drill_type(d) for d in fixtures.plan()["drills"]}
    assert types == {"d1": "warmup", "d2": "individual", "b1": "break", "d3": "team", "d4": "team", "b2": "break",
                     "d5": "special_teams", "d6": "conditioning", "d7": "cooldown"}
    assert metabolic.drill_type({"name": "x", "intensity": "hard", "drill_type": "individual"}) == "individual"
