"""JOS-3 cross-check of twonode-v1 (Takahashi et al. 2021, Energy & Buildings 231:110575; pythermalcomfort JOS3).

The same scenario — drill-by-drill activity, gear, sun/shade and weather — is run through JOS-3 by changing
``par``, ``clo``, ``tdb``, ``tr``, ``rh`` and ``v`` between one-step ``simulate()`` calls, and the core-temperature
gap against our model is reported. JOS-3's pelvis core node stands in for rectal temperature.

Mapping, and what doesn't carry over (so the gap isn't over-interpreted):
  * par = whole-body metabolic power (our MET × W/kg × mass) / JOS-3 basal metabolic rate, floored at 1 because
    JOS-3 can't go below basal.
  * clo = intrinsic insulation of the gear level, applied uniformly to all 17 segments. JOS-3 takes no
    per-gear evaporative resistance; it derives its own from clo.
  * v = body-height wind. JOS-3 has no activity-induced air movement term, which Gagge has.
  * deterministic: our p50 is compared with JOS-3's single run (calibration scales = 1).

Usage:  python -m engine.physio.jos3_ref  [--athletes a01,a02]   (fixtures; prints the gap table)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np

from engine import consts
from engine.physio import clothing, metabolic, twonode

ROOT = Path(__file__).resolve().parents[2]


def run_jos3(athlete: Mapping[str, Any], tl: twonode.Timeline, i: int, env: twonode.Environment,
             step_min: float) -> np.ndarray:
    """Core (pelvis) temperature per step for athlete row ``i`` of the timeline."""
    from pythermalcomfort.models import JOS3

    kw = dict(height=float(athlete["height_m"]), weight=float(athlete["mass_kg"]),
              age=int(athlete["age_yr"]), sex=athlete.get("sex", "male"))
    if athlete.get("body_fat_pct") is not None:
        kw["fat"] = float(athlete["body_fat_pct"])
    model = JOS3(**kw)
    model.posture = "standing"
    bmr_w = model.bmr * float(np.sum(model.bsa))
    m_w = tl.met[i] * metabolic.w_per_kg_per_met() * float(athlete["mass_kg"])
    gears = [clothing.gear_props(g) for g in clothing.GEAR_LEVELS]
    core = np.empty(tl.n_steps)
    for s in range(tl.n_steps):
        model.par = max(float(m_w[s] / bmr_w), 1.0)
        model.clo = gears[int(tl.gear[i, s])].i_cl_clo
        model.tdb = float(env.ta[s])
        model.tr = float(env.ta[s] if tl.shade[i, s] else env.tr_sun[s])
        model.rh = float(env.rh[s])
        model.v = float(env.v_body[s])
        model.simulate(times=1, dtime=step_min * 60.0, output=False)
        core[s] = float(model.t_core[4])  # pelvis
    return core


def compare(roster: Sequence[Mapping[str, Any]], plan: Mapping[str, Any], weather: Sequence[Mapping[str, Any]],
            step_min: float = 1.0, athlete_ids: Sequence[str] | None = None,
            clothing_mode: str | None = None) -> dict[str, Any]:
    """Run twonode-v1 (deterministic, scales = 1) and JOS-3 on the same scenario; report the core gap.

    ``clothing_mode`` selects twonode's clothing path ("iso7933_dynamic" default, or "gagge_static", which is
    closer to JOS-3's own static clo-based clothing treatment).
    """
    sel = [a for a in roster if athlete_ids is None or a["id"] in athlete_ids]
    t0 = twonode.parse_time(plan["start"])
    R = twonode.build_roster(sel)
    tl = twonode.build_timeline(plan["drills"], R.ids, step_min)
    env = twonode.build_environment(weather, plan["site"], t0, step_min, tl.n_steps)
    zero = twonode.Draws(z_met=np.zeros((1, len(sel))), z_thermo=np.zeros((1, len(sel))))
    mode = clothing_mode or consts.get("model_options.clothing_mode")
    ours = twonode.simulate_arrays(tl, env, R, zero, clothing_mode=mode).core[0]  # [N, S]
    rows = []
    for i, a in enumerate(sel):
        j = run_jos3(a, tl, i, env, step_min)
        d = ours[i] - j
        rows.append({
            "id": a["id"],
            "twonode_peak_c": round(float(ours[i].max()), 3),
            "jos3_peak_c": round(float(j.max()), 3),
            "peak_gap_c": round(float(ours[i].max() - j.max()), 3),
            "mean_gap_c": round(float(d.mean()), 3),
            "max_abs_gap_c": round(float(np.abs(d).max()), 3),
            "rmse_c": round(float(np.sqrt(np.mean(d ** 2))), 3),
            "twonode_core_c": np.round(ours[i], 3).tolist(),
            "jos3_core_c": np.round(j, 3).tolist(),
        })
    return {
        "plan_id": plan["id"],
        "step_min": step_min,
        "reference": "JOS-3 (pythermalcomfort JOS3), pelvis core node",
        "twonode_clothing_mode": mode,
        "labels": [twonode.ESTIMATE_LABEL, "model cross-check, not a validation against measured data"],
        "unverified_constants": consts.unverified(twonode.MODEL_BLOCKS),
        "athletes": rows,
        "summary": {
            "mean_peak_gap_c": round(float(np.mean([r["peak_gap_c"] for r in rows])), 3),
            "max_abs_gap_c": round(float(np.max([r["max_abs_gap_c"] for r in rows])), 3),
            "mean_rmse_c": round(float(np.mean([r["rmse_c"] for r in rows])), 3),
        },
    }


def _load_fixtures():
    from engine import fixtures
    return fixtures.roster(), fixtures.plan(), fixtures.forecast()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--athletes", default=None, help="comma-separated athlete ids (default: all)")
    ap.add_argument("--out", default=None, help="write the full JSON report here")
    ap.add_argument("--clothing-mode", default=None, choices=["iso7933_dynamic", "gagge_static"])
    args = ap.parse_args()
    roster, plan, weather = _load_fixtures()
    ids = args.athletes.split(",") if args.athletes else None
    rep = compare(roster, plan, weather, athlete_ids=ids, clothing_mode=args.clothing_mode)
    print(f"JOS-3 cross-check — {rep['plan_id']}, twonode clothing mode {rep['twonode_clothing_mode']} "
          f"({'; '.join(rep['labels'])})")
    print(f"{'id':5} {'twonode peak':>13} {'JOS-3 peak':>11} {'peak gap':>9} {'mean gap':>9} {'RMSE':>6}")
    for r in rep["athletes"]:
        print(f"{r['id']:5} {r['twonode_peak_c']:13.2f} {r['jos3_peak_c']:11.2f} {r['peak_gap_c']:+9.2f} "
              f"{r['mean_gap_c']:+9.2f} {r['rmse_c']:6.2f}")
    print("summary:", json.dumps(rep["summary"]))
    if args.out:
        Path(args.out).write_text(json.dumps(rep, indent=1))


if __name__ == "__main__":
    main()
