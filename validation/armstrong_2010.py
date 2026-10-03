"""WS7 item 1 — reproduce Armstrong et al. 2010 (J Athl Train 45:117) with twonode-v1.

Protocol (constants.armstrong_2010, VERIFIED): linemen (mean 117.4 kg, 1.839 m, 23.8 y) in a 33 °C / 48.5 % RH chamber,
10 min repetitive box lifting → 10 min seated → treadmill 5.6 km/h, 5 % grade until 60 min or termination.
Measured: rate of rectal-temperature rise during treadmill exercise (Table 4) and over the whole protocol (Table 3).

Simulation assumptions (constants.armstrong_2010_reproduction, DESIGN): Compendium METs for each task; air speed not
reported (Gagge still-air floor, with a sensitivity sweep); MRT = air temperature (indoor chamber); a deterministic run
(calibration scales = 1) for the mean participant; start core = measured 37.2 °C; treadmill length = the condition's
mean exposure time − 20 min; CON → gear 'none' (our 'none' adds a T-shirt), FULL → 'full_pads'; PART has no matching
gear level.

    python -m validation.armstrong_2010              # run, print, write validation/results.json
    python -m validation.armstrong_2010 --calibrate  # print the conservative-mode λ that matches FULL

Every number written to results.json is computed here from those inputs. The conservative mode is *calibrated* on the
FULL treadmill mean, so its FULL result is a fit, not an independent validation; CON and the whole-protocol rates are
not fitted.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from engine import consts
from engine.physio import clothing, metabolic, twonode

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"
MODES = ("conservative", "iso7933_dynamic", "gagge_static")
REFERENCE_MODELS = ("jos3",)


def simulate(condition: str, clothing_mode: str, air_speed: float | None = None,
             surcharge: float | None = None) -> dict[str, float]:
    """Deterministic twonode-v1 run of the protocol for the mean participant → rates (°C/min) and end core."""
    A = consts.get("armstrong_2010")
    S = consts.get("armstrong_2010_reproduction")
    gear = S["gear_map"][condition]
    v = float(S["air_speed_m_s"] if air_speed is None else air_speed)
    pt = A["participants"]
    mass, height = pt["mass_kg"], pt["height_m"]
    bsa = float(metabolic.body_surface_area_m2(mass, height))

    pre = A["protocol_min"]["box_lifting"] + A["protocol_min"]["seated"]
    tread = int(round(A["exposure_min"][condition] - pre))
    mets = np.r_[np.full(A["protocol_min"]["box_lifting"], S["met"]["box_lifting"]),
                 np.full(A["protocol_min"]["seated"], S["met"]["seated"]),
                 np.full(tread, S["met"]["treadmill"])]
    n = len(mets)
    one = np.ones((1, n))
    ta = np.full(n, A["chamber"]["air_temp_c"])
    pa = A["chamber"]["rh_pct"] / 100.0 * twonode.psat_mmhg(ta)
    gt = clothing.gear_table()
    gi = clothing.gear_index(gear)

    met_wm2 = metabolic.met_to_w_m2(mets, mass, bsa)[None, :]
    if clothing_mode == "conservative":
        sc = twonode.gear_met_surcharge()[gi]
        if surcharge is not None:  # calibration: override δ for full pads
            sc = surcharge * (
                (gt["i_cl_clo"][gi] - gt["i_cl_clo"][clothing.gear_index("none")])
                / (gt["i_cl_clo"][clothing.gear_index("full_pads")] - gt["i_cl_clo"][clothing.gear_index("none")]))
        met_wm2 = met_wm2 * (1.0 + sc)
    athlete = {"id": "armstrong_mean", "name": "Armstrong 2010 mean participant", "height_m": height, "mass_kg": mass,
               "age_yr": pt["age_yr"], "sex": pt["sex"], "acclimatization_day": S["acclimatization_day"],
               "position": "OL"}
    R = twonode.build_roster([athlete])
    iso = None
    if clothing_mode in ("conservative", "iso7933_dynamic"):
        d = consts.get("iso7933_dynamic")
        w_max = d["w_max_unacclimatized"] + R.accl_frac * (d["w_max_acclimatized"] - d["w_max_unacclimatized"])
        iso = twonode.IsoClothing(i_t=gt["i_t"][gi] * one, i_m=gt["i_m"][gi] * one, i_cl_clo=gt["i_cl_clo"][gi] * one,
                                  w_max=w_max, fraction=twonode.iso_fraction(clothing_mode),
                                  walk_credit=twonode.walk_credit(clothing_mode))
    out = twonode.integrate(
        met_wm2=met_wm2, met_scale=np.ones((1, 1)),
        ta=ta, pa=pa, v=np.full(n, v), tr=ta[None, :],
        r_cl=gt["r_cl"][gi] * one, r_ecl=gt["r_ecl"][gi] * one, f_cl=gt["f_cl"][gi] * one,
        clothed=np.full((1, n), bool(gt["clothed"][gi])),
        mass_kg=np.array([mass]), bsa_m2=np.array([bsa]), dt_s=60.0,
        theta_sw=R.sw_gain[None, :], setpoint_shift=R.setpoint_shift, tcr0=np.array([A["start_rectal_c"]]),
        met_cap_wm2=metabolic.met_to_w_m2(R.met_cap, R.mass_kg, R.bsa_m2),
        cap_mode=consts.get("model_options.cap_mode"), iso=iso,
    )
    core = np.r_[A["start_rectal_c"], out.core[0, 0]]  # core[k] = state after k minutes
    return {
        "treadmill_rate_c_per_min": float((core[n] - core[pre]) / tread),
        "whole_protocol_rate_c_per_min": float((core[n] - core[0]) / n),
        "rise_c": float(core[n] - core[0]),
        "end_core_c": float(core[n]),
        "treadmill_min": tread,
    }


def simulate_jos3(condition: str, air_speed: float | None = None) -> dict[str, float]:
    """Same protocol through JOS-3 (pythermalcomfort): par = Compendium metabolic power / JOS-3 BMR, clo = static
    intrinsic insulation of the mapped gear (uniform over segments), MRT = air temperature, pelvis core node."""
    from pythermalcomfort.models import JOS3

    A = consts.get("armstrong_2010")
    S = consts.get("armstrong_2010_reproduction")
    pt = A["participants"]
    v = float(S["air_speed_m_s"] if air_speed is None else air_speed)
    model = JOS3(height=pt["height_m"], weight=pt["mass_kg"], fat=pt["body_fat_pct"], age=int(round(pt["age_yr"])),
                 sex=pt["sex"])
    model.posture = "standing"
    bmr_w = model.bmr * float(np.sum(model.bsa))
    clo = clothing.gear_props(S["gear_map"][condition]).i_cl_clo
    pre = A["protocol_min"]["box_lifting"] + A["protocol_min"]["seated"]
    tread = int(round(A["exposure_min"][condition] - pre))
    mets = ([S["met"]["box_lifting"]] * A["protocol_min"]["box_lifting"] + [S["met"]["seated"]] * A["protocol_min"]["seated"]
            + [S["met"]["treadmill"]] * tread)
    core = []
    for met in mets:
        model.par = max(met * metabolic.w_per_kg_per_met() * pt["mass_kg"] / bmr_w, 1.0)
        model.clo, model.tdb, model.tr = clo, A["chamber"]["air_temp_c"], A["chamber"]["air_temp_c"]
        model.rh, model.v = A["chamber"]["rh_pct"], v
        model.simulate(times=1, dtime=60.0, output=False)
        core.append(float(model.t_core[4]))
    core0 = core[0]  # JOS-3 starts from its own neutral state; rates are compared, not absolute temperatures
    n = len(core)
    return {
        "treadmill_rate_c_per_min": float((core[n - 1] - core[pre - 1]) / tread),
        "whole_protocol_rate_c_per_min": float((core[n - 1] - core0) / (n - 1)),
        "rise_c": float(core[n - 1] - core0),
        "end_core_c": float(core[n - 1]),
        "treadmill_min": tread,
    }


def calibrate(tol: float = 1e-5) -> float:
    """Full-pads metabolic surcharge δ ≥ 0 such that the FULL treadmill rate (conservative mode) = measured mean."""
    target = consts.get("armstrong_2010.treadmill_rate_c_per_min.FULL")[0]
    f = lambda d: simulate("FULL", "conservative", surcharge=d)["treadmill_rate_c_per_min"] - target  # noqa: E731
    lo, hi = 0.0, 1.0
    if f(lo) >= 0:
        return 0.0
    if f(hi) < 0:
        raise RuntimeError("a 100 % surcharge still under-predicts FULL")
    while hi - lo > tol:
        mid = 0.5 * (lo + hi)
        if f(mid) < 0:
            lo = mid
        else:
            hi = mid
    return round(0.5 * (lo + hi), 4)


def run() -> dict:
    A = consts.get("armstrong_2010")
    S = consts.get("armstrong_2010_reproduction")
    rows = []
    for mode in MODES + REFERENCE_MODELS:
        for cond in S["gear_map"]:
            for v in S["air_speed_sensitivity_m_s"]:
                sim = simulate_jos3(cond, air_speed=v) if mode == "jos3" else simulate(cond, mode, air_speed=v)
                rise, rise_sd = A["rise_c"][cond]
                meas, sd = A["treadmill_rate_c_per_min"][cond]
                wmeas, wsd = A["whole_protocol_rate_c_per_min"][cond]
                rows.append({
                    "clothing_mode": mode, "condition": cond, "gear": S["gear_map"][cond], "air_speed_m_s": v,
                    "model_treadmill_rate_c_per_min": round(sim["treadmill_rate_c_per_min"], 4),
                    "measured_treadmill_rate_c_per_min": meas, "measured_sd": sd,
                    "treadmill_error_c_per_min": round(sim["treadmill_rate_c_per_min"] - meas, 4),
                    "treadmill_error_in_sd": round((sim["treadmill_rate_c_per_min"] - meas) / sd, 2),
                    "model_whole_protocol_rate_c_per_min": round(sim["whole_protocol_rate_c_per_min"], 4),
                    "measured_whole_protocol_rate_c_per_min": wmeas, "measured_whole_sd": wsd,
                    "model_rise_c": round(sim["rise_c"], 2), "measured_rise_c": rise, "measured_rise_sd": rise_sd,
                    "model_end_core_c": round(sim["end_core_c"], 2),
                    "fitted": bool(mode == "conservative" and cond == "FULL" and v == S["air_speed_m_s"]),
                })
    summary = {}
    ref_v = S["air_speed_m_s"]
    for mode in MODES + REFERENCE_MODELS:
        rs = [r for r in rows if r["clothing_mode"] == mode and r["air_speed_m_s"] == ref_v]
        unfitted = [r for r in rs if not r["fitted"]]
        e_t = [r["treadmill_error_c_per_min"] for r in unfitted]
        e_w = [r["model_whole_protocol_rate_c_per_min"] - r["measured_whole_protocol_rate_c_per_min"] for r in rs]
        e_r = [r["model_rise_c"] - r["measured_rise_c"] for r in rs]
        summary[mode] = {
            "treadmill_rate_rmse_unfitted_c_per_min": round(float(np.sqrt(np.mean(np.square(e_t)))), 4) if e_t else None,
            "whole_protocol_rate_rmse_c_per_min": round(float(np.sqrt(np.mean(np.square(e_w)))), 4),
            "whole_protocol_rate_max_abs_error_c_per_min": round(float(np.max(np.abs(e_w))), 4),
            "rise_rmse_c": round(float(np.sqrt(np.mean(np.square(e_r)))), 2),
            "rise_max_abs_error_c": round(float(np.max(np.abs(e_r))), 2),
            "n_comparisons": len(rs),
        }
    return {
        "study": "Armstrong et al. 2010, J Athl Train 45:117 (PMC2838463)",
        "comparison_basis": "summary values only (Table 3 whole-protocol rise and rate, Table 4 treadmill rate); Figure 2's time course is not tabulated and was not digitized, so no time-point RMSE is reported",
        "summary_at_reference_air_speed": summary,
        "computed_by": "validation/armstrong_2010.py",
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": twonode.MODEL_NAME,
        "conservative_gear_met_surcharge_full_pads": consts.get("clothing_conservative.gear_met_surcharge_full_pads"),
        "synthetic": False,
        "notes": [
            "Deterministic run for the mean participant; measured values are group means ± SD of 10 men.",
            "Conservative mode is calibrated on FULL at the reference air speed (row with fitted=true) — that row is a fit, not a validation.",
            "Air speed and metabolic rate were not reported; METs from the 2024 Compendium (task mapping is a judgement call).",
            "CON maps to gear 'none', which includes a T-shirt that Armstrong's CON did not wear; PART has no matching gear level.",
            "JOS-3 uses static intrinsic clo of the mapped gear (it takes no evaporative resistance input) and starts from its own neutral state; rates and rises are compared, not absolute temperatures.",
            "estimate — planning only",
        ],
        "rows": rows,
    }


def write(result: dict) -> None:
    data = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    data["armstrong_2010"] = result
    RESULTS.write_text(json.dumps(data, indent=1) + "\n")


def main() -> None:
    ap = argparse.ArgumentParser(description="Armstrong 2010 reproduction")
    ap.add_argument("--calibrate", action="store_true")
    args = ap.parse_args()
    if args.calibrate:
        d = calibrate()
        print(f"conservative gear_met_surcharge_full_pads δ = {d}")
        print(json.dumps(simulate("FULL", "conservative", surcharge=d)))
        return
    res = run()
    write(res)
    print(f"{'mode':16} {'cond':5} {'v':>4} {'model':>7} {'meas':>6} {'±SD':>6} {'err/SD':>7}  whole(model/meas)  rise(model/meas)")
    for r in res["rows"]:
        print(f"{r['clothing_mode']:16} {r['condition']:5} {r['air_speed_m_s']:4.1f} "
              f"{r['model_treadmill_rate_c_per_min']:7.4f} {r['measured_treadmill_rate_c_per_min']:6.3f} "
              f"{r['measured_sd']:6.3f} {r['treadmill_error_in_sd']:7.2f}  "
              f"{r['model_whole_protocol_rate_c_per_min']:.4f}/{r['measured_whole_protocol_rate_c_per_min']:.3f}  "
              f"{r['model_rise_c']:.2f}/{r['measured_rise_c']:.2f}" + ("  (fit)" if r["fitted"] else ""))
    print("summary (reference air speed):", json.dumps(res["summary_at_reference_air_speed"], indent=1))
    print(f"wrote {RESULTS}")


if __name__ == "__main__":
    main()
