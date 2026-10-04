"""Recorded data the app replays (CONTRACTS.md v1.3): heart-rate files for /live/replay and field-node files for
/node/latest.

* HR: the demo-plan replay is the synthetic ``fixtures/hr_a07_synthetic.csv`` (labelled synthetic) unless a file is
  named. Real ``fixtures/hr_<date>.csv`` recordings (engine/hr_bridge.py) are calibration evidence
  (validation/helio_recording.py), not projected onto the demo plan by default: the Oct 3 Helio recording is rest and
  burpees, not football drills (owner decision, polish 3). A file is synthetic when its header comment or
  ``synthetic`` column says so. A named real recording's clock is shifted so its first reading lands on the plan start
  (labelled).
* Node: live readings POSTed to /node are served by engine/node_routes.py; with none in memory, /node/latest falls back
  to the newest ``data/node_<date>.csv`` written by engine/node_bridge.py, else nothing — the caller then says
  "no field recording yet" and shows no numbers.
"""
from __future__ import annotations

import csv
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

from engine import calibrate, consts
from engine.physio import twonode

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "fixtures"
DATA = ROOT / "data"
SYNTHETIC_HR = "hr_a07_synthetic.csv"
NO_FIELD = "no field recording yet"


# ── heart rate ───────────────────────────────────────────────────────────────

def hr_is_synthetic(path: Path) -> bool:
    with open(path) as f:
        head = f.readline()
        if head.startswith("#") and "SYNTHETIC" in head.upper() and "NOT SYNTHETIC" not in head.upper():
            return True
        rows = csv.DictReader(line for line in f if not line.startswith("#"))
        first = next(rows, None)
    return bool(first and str(first.get("synthetic", "")).lower() == "true")


def pick_hr_file(name: Optional[str] = None) -> Path:
    """``name`` under fixtures/ if given; else the synthetic fixture (a real recording is replayed only when named)."""
    if name:
        p = (FIXTURES / Path(name).name)
        if not p.exists():
            raise FileNotFoundError(f"no HR file fixtures/{p.name}")
        return p
    return FIXTURES / SYNTHETIC_HR


def real_hr_files() -> list[Path]:
    """Real recordings (hr_bridge), oldest first."""
    return sorted(p for p in FIXTURES.glob("hr_*.csv") if not hr_is_synthetic(p))


def hr_device(rows: Sequence[Mapping[str, Any]]) -> str:
    """The strap named in the recording's ``device`` column (most common value), e.g. the Amazfit Helio Strap."""
    from collections import Counter
    c = Counter(str(r.get("device") or "").strip() for r in rows if str(r.get("device") or "").strip())
    return c.most_common(1)[0][0] if c else "device not recorded"


def _align(rows: list[dict[str, Any]], plan_start: str) -> tuple[list[dict[str, Any]], bool]:
    """Shift a recording so its first reading is at the plan start, unless it already falls inside the plan."""
    if not rows:
        return rows, False
    t0 = twonode.parse_time(plan_start)
    first = twonode.parse_time(rows[0]["ts"])
    if abs((first - t0).total_seconds()) < consts.get("calibration.update_interval_s"):
        return rows, False
    dt = t0 - first
    return [{**r, "ts": (twonode.parse_time(r["ts"]) + dt).isoformat()} for r in rows], True


def run_replay(plan: Mapping[str, Any], roster: Sequence[Mapping[str, Any]], weather: Sequence[Mapping[str, Any]],
               *, settings=None, seed: int = 0, n_ensemble: int, extra_labels: Sequence[str] = (),
               file: Optional[str] = None) -> dict[str, Any]:
    path = pick_hr_file(file)
    synthetic = hr_is_synthetic(path)
    ids = {a["id"] for a in roster}
    rows_all = calibrate.read_hr_csv(path)
    rows = [r for r in rows_all if r["athlete_id"] in ids]
    rows, aligned = _align(rows, plan["start"])
    labels = ["replay", *extra_labels]
    if synthetic:
        labels.insert(1, "synthetic HR (not a real athlete)")
    else:
        labels.insert(1, f"real HR recording — {hr_device(rows_all)}, {rows_all[0]['ts'][:10] if rows_all else '?'} "
                         f"(fixtures/{path.name})")
    if aligned:
        labels.append("recording clock shifted so its first reading is the plan start")
    if len(rows) < len(rows_all):
        labels.append(f"{len(rows_all) - len(rows)} readings from athletes not on this roster were skipped")

    prior = twonode.simulate_roster(roster, plan, weather, n_ensemble=n_ensemble, seed=seed, settings=settings,
                                    extra_labels=extra_labels)
    session = calibrate.LiveSession(plan, roster, weather, settings=settings, seed=seed, extra_labels=extra_labels)
    t0 = twonode.parse_time(plan["start"])
    frames: list[dict[str, Any]] = []
    series: dict[str, list[list[float]]] = {}
    every = consts.get("live_replay.hr_series_every_s")
    last_kept: dict[str, float] = {}
    for r in rows:
        r = {**r, "replay": True}
        ts = twonode.parse_time(r["ts"])
        minute = (ts - t0).total_seconds() / 60.0
        aid = r["athlete_id"]
        if aid not in last_kept or ts.timestamp() - last_kept[aid] >= every:
            series.setdefault(aid, []).append([round(minute, 3), r["hr_bpm"]])
            last_kept[aid] = ts.timestamp()
        o = session.add_reading(r)
        if not o["updated"] or "reforecast" not in o:
            continue
        a = next(x for x in o["reforecast"]["athletes"] if x["id"] == aid)
        frames.append({"minute": round(minute, 3), "athlete_id": aid, "hr_bpm": r["hr_bpm"],
                       "calib": {k: o["calib"][k] for k in ("met_scale", "met_scale_sd")},
                       "gates": o.get("gates", {}),
                       "athlete": {k: a.get(k) for k in ("core_c_p50", "core_c_p95", "peak_core_c_p95", "status",
                                                         "first_cross_min")}})
    return {
        "source": {"file": f"fixtures/{path.name}", "synthetic": synthetic,
                   "date": None if synthetic else (rows_all[0]["ts"][:10] if rows_all else None),
                   "device": None if synthetic else hr_device(rows_all),
                   "label": ("replay · synthetic HR file (not a real athlete)" if synthetic else
                             f"replay · {rows_all[0]['ts'][:10] if rows_all else '?'} · {hr_device(rows_all)}"),
                   "athletes": sorted({r["athlete_id"] for r in rows}),
                   "n_readings": len(rows), "first_ts": rows[0]["ts"] if rows else None,
                   "last_ts": rows[-1]["ts"] if rows else None, "aligned_to_plan_start": aligned},
        "plan_forecast": prior,
        "frames": frames,
        "hr_series": series,
        "labels": labels,
    }


# ── field node ───────────────────────────────────────────────────────────────

def _num(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v != v else v  # NaN → None


def newest_node_csv(real_only: bool = False) -> Optional[Path]:
    """Newest data/node_<date>.csv; with ``real_only`` the newest one holding field readings (mode live/replay), not
    only the indoor DEMO scenario (mode demo, synthetic)."""
    # node_field_<date>.csv (Arduino field mode: an air-temperature thermistor + NWS, no globe) is not a globe recording
    files = sorted(f for f in DATA.glob("node_*.csv") if not f.name.startswith("node_field_")) if DATA.exists() else []
    if real_only:
        files = [f for f in files if field_rows(_read_node_csv(f))]
    return files[-1] if files else None


def field_rows(rows: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Readings from the field (node_bridge mode live or replay); the indoor demo scenario (mode demo) is synthetic."""
    return [r for r in rows if str(r.get("mode", "live")).lower() != "demo"]


def _read_node_csv(path: Path) -> list[dict[str, Any]]:
    with open(path) as f:
        return [r for r in csv.DictReader(line for line in f if not line.startswith("#"))]


def _reading(row: Mapping[str, Any]) -> dict[str, Any]:
    out = {"ts": row["ts"], "air_source": row.get("air_source"),
           "globe_calibrated": str(row.get("globe_calibrated", "")).lower() == "true"}
    for k in ("globe_c", "air_c", "rh_pct", "node_wbgt_f", "forecast_wbgt_f", "field_minus_forecast_f", "tub_temp_c"):
        out[k] = _num(row.get(k))
    z = _num(row.get("fhsaa_zone"))
    out["fhsaa_zone"] = int(z) if z is not None else None
    return out


def _per_minute(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Last reading of each clock minute (the node logs every few seconds)."""
    by_min: dict[str, Mapping[str, Any]] = {}
    for r in rows:
        by_min[str(r["ts"])[:16]] = r
    return [{"ts": r["ts"], "node_wbgt_f": _num(r.get("node_wbgt_f")), "forecast_wbgt_f": _num(r.get("forecast_wbgt_f"))}
            for r in by_min.values()]


def node_latest() -> dict[str, Any]:
    """Newest real field recording (preferred over a demo-scenario file), labelled with its date and node."""
    path = newest_node_csv(real_only=True) or newest_node_csv()
    if path is not None:
        all_rows = _read_node_csv(path)
        rows = field_rows(all_rows) or all_rows
        if rows:
            last = _reading(rows[-1])
            demo = rows is all_rows and not field_rows(all_rows)
            labels = ([f"DEMO scenario recording (synthetic) — data/{path.name}"] if demo else
                      [f"field node recording — {str(rows[0]['ts'])[:10]}, node-1 black-globe node (data/{path.name})"])
            if not last["globe_calibrated"]:
                labels.append("globe thermistor uncalibrated")
            if last.get("air_source"):
                labels.append(f"air temperature / humidity from {last['air_source']}")
            if str(rows[-1].get("mode", "")).lower() == "replay":
                labels.append("replay")
            return {"reading": last, "series": _per_minute(rows), "file": f"data/{path.name}", "labels": labels}
    return {"reading": None, "series": [], "file": None, "labels": [NO_FIELD]}



