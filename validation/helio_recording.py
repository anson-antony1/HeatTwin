"""Real heart-rate recording from the Amazfit Helio Strap as calibration evidence (owner decision, polish 3).

    python -m validation.helio_recording     # prints, and writes validation/results.json["helio_recording"]

The Oct 3 recording (fixtures/hr_2026-10-03.csv, engine/hr_bridge.py; the wearer's own, consented) is rest and then
burpees, not football drills, so it is not replayed on the demo plan's clock. Doing that compared burpee heart rate
with warm-up intensity, which produced met_scale 1.63 and a 42.25 °C peak. This script reports what the recording is:
readings, duration and HR min/mean/max. It also reports how met_scale moves when the recording is fed through live
calibration under the live-demo mapping (/live/start {"live_demo": {"a07": "conditioning"}}): the strap wearer's HR is
read against the plan's conditioning drill, the intensity that burpees match.

Limits, said in the labels:
- the HR observation model uses roster athlete a07's synthetic profile (resting HR, age, VO2max), not the wearer's
  (calibration.profile_synthetic: true);
- windows that look like rest are skipped (constants.live_demo); recovery windows nearer the drill's HR count as
  conditioning, which pulls met_scale down;
- windows above the modelled HR ceiling teach nothing and are counted;
- the filter has no process noise, so the ensemble spread shrinks with every update: a tight spread is not agreement;
- the HR model has no cardiovascular-drift term, so weather does not enter calibration.
"""
from __future__ import annotations

import json
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "validation" / "results.json"
LIVE_DEMO_DRILL = "conditioning"     # the live-demo mapping's drill (docs/LIVE_HR.md)


def _newest_helio() -> Optional[Path]:
    from engine import demo_data
    files = [p for p in demo_data.real_hr_files()
             if "helio" in demo_data.hr_device(_rows(p)).lower()]
    return files[-1] if files else None


def _rows(path: Path) -> list[dict[str, Any]]:
    from engine import calibrate
    return calibrate.read_hr_csv(path)


def compute(path: Optional[Path] = None) -> dict[str, Any]:
    from engine import calibrate, consts, demo_data, fixtures
    path = path or _newest_helio()
    if path is None:
        return {"status": "no Amazfit Helio Strap recording in fixtures/", "synthetic": False}
    rows = _rows(path)
    hr = [r["hr_bpm"] for r in rows]
    t = [datetime.fromisoformat(r["ts"]) for r in rows]
    per_min: "OrderedDict[str, list[float]]" = OrderedDict()
    for r in rows:
        per_min.setdefault(r["ts"][:16], []).append(r["hr_bpm"])
    athletes = sorted({r["athlete_id"] for r in rows})

    # how met_scale moves under the live-demo mapping (conditioning drill at every minute; rest-like windows skipped)
    plan = fixtures.plan()
    plan["start"] = t[0].replace(second=0, microsecond=0).isoformat()
    drill = calibrate.match_drill(plan, LIVE_DEMO_DRILL)
    roster = fixtures.roster()
    on_roster = [a for a in athletes if a in {x["id"] for x in roster}]
    seed = int(consts.get("demo_mode.seed"))
    session = calibrate.LiveSession(plan, roster, fixtures.forecast(), seed=seed,
                                    observe={a: drill for a in on_roster})
    traj: list[dict[str, Any]] = []
    prior = {a: session.calib(a) for a in on_roster}
    for r in rows:
        if r["athlete_id"] not in session.state:
            continue
        o = session.add_reading({**r, "replay": True}, reforecast=False)
        if o["updated"]:
            traj.append({"minute": round((datetime.fromisoformat(r["ts"]) - t[0]).total_seconds() / 60.0, 2),
                         "athlete_id": r["athlete_id"], "met_scale": o["calib"]["met_scale"],
                         "met_scale_sd": o["calib"]["met_scale_sd"]})
    aid = on_roster[0] if on_roster else None
    mine = [x for x in traj if x["athlete_id"] == aid]
    last5 = [x["met_scale"] for x in mine[-5:]]
    p0 = prior.get(aid, {})
    conv = None
    if mine:
        conv = {
            "athlete_id": aid,
            "mapped_drill": {"id": drill["id"], "name": drill["name"], "intensity": drill["intensity"],
                             "gear": drill["gear"]},
            "update_interval_s": consts.get("calibration.update_interval_s"),
            "window_s": consts.get("calibration.window_s"),
            "n_updates": len(mine),
            "n_windows_skipped_rest": session.state[aid].skipped_rest,
            "n_windows_ceiling_held": session.state[aid].ceiling_held,
            "profile_synthetic": True,
            "prior_met_scale": p0.get("met_scale"), "prior_met_scale_sd": p0.get("met_scale_sd"),
            "final_met_scale": mine[-1]["met_scale"], "final_met_scale_sd": mine[-1]["met_scale_sd"],
            "sd_reduction_pct": round(100.0 * (1.0 - mine[-1]["met_scale_sd"] / p0["met_scale_sd"]), 1)
            if p0.get("met_scale_sd") else None,
            "last5_met_scale_range": [min(last5), max(last5)],
            "seed": seed,
            "trajectory": mine,
        }
    device = demo_data.hr_device(rows)
    date = rows[0]["ts"][:10]
    labels = [f"real HR recording — {device}, {date} (fixtures/{path.name}); the wearer's own, consented",
              "rest, then burpees — not football drills; not replayed on the demo plan's clock",
              f"calibration read against the plan's '{drill['name']}' drill ({drill['intensity']}) — the live-demo "
              "mapping; windows that look like rest are skipped, recovery windows count as conditioning",
              f"HR observation model uses roster athlete {aid}'s synthetic profile, not the wearer's",
              "no process noise: the spread shrinks with every update, so a tight spread is not agreement",
              "no cardiovascular-drift term in the HR model: weather does not enter calibration",
              "replay: true — recorded HR fed through live calibration"]
    return {
        "computed_by": "validation/helio_recording.py",
        "computed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "synthetic": False, "replay": True,
        "file": f"fixtures/{path.name}", "device": device, "date": date, "athlete_ids": athletes,
        "n_readings": len(rows), "first_ts": rows[0]["ts"], "last_ts": rows[-1]["ts"],
        "duration_min": round((t[-1] - t[0]).total_seconds() / 60.0, 1),
        "hr_bpm": {"min": min(hr), "mean": round(mean(hr), 1), "max": max(hr)},
        "per_minute_mean_hr_bpm": [{"minute": k[11:16], "n": len(v), "mean": round(mean(v), 1)} for k, v in per_min.items()],
        "calibration": conv,
        "labels": labels,
    }


def write(out: dict[str, Any]) -> None:
    results = json.loads(RESULTS.read_text()) if RESULTS.exists() else {}
    results["helio_recording"] = out
    RESULTS.write_text(json.dumps(results, indent=2) + "\n")


def main() -> None:
    out = compute()
    write(out)
    if "status" in out:
        print(out["status"])
        return
    h, c = out["hr_bpm"], out["calibration"]
    print(f"{out['file']}: {out['n_readings']} readings over {out['duration_min']} min; HR {h['min']}/{h['mean']}/{h['max']} bpm")
    if c:
        print(f"met_scale {c['prior_met_scale']} ± {c['prior_met_scale_sd']} → {c['final_met_scale']} ± "
              f"{c['final_met_scale_sd']} after {c['n_updates']} updates (sd −{c['sd_reduction_pct']} %); last 5 "
              f"{c['last5_met_scale_range']}")


if __name__ == "__main__":
    main()
