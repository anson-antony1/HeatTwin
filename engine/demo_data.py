"""Recorded data the app replays (CONTRACTS.md v1.3): heart-rate files for /live/replay and field-node files for
/node/latest.

* HR: the newest real ``fixtures/hr_<date>.csv`` written by engine/hr_bridge.py wins; otherwise the synthetic
  ``fixtures/hr_a07_synthetic.csv``. A file is synthetic when its header comment or ``synthetic`` column says so.
  A real recording's clock is shifted so its first reading lands on the plan start (labelled).
* Node: the newest ``data/node_<date>.csv`` written by engine/node_bridge.py, else readings POSTed to /node during
  this engine run, else nothing — the caller then says "no field recording yet" and shows no numbers.
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
    """``name`` under fixtures/ if given; else the newest real hr_*.csv; else the synthetic fixture."""
    if name:
        p = (FIXTURES / Path(name).name)
        if not p.exists():
            raise FileNotFoundError(f"no HR file fixtures/{p.name}")
        return p
    real = sorted(p for p in FIXTURES.glob("hr_*.csv") if not hr_is_synthetic(p))
    return real[-1] if real else FIXTURES / SYNTHETIC_HR


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
        labels.insert(1, f"real HR recording ({path.name})")
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
        "source": {"file": f"fixtures/{path.name}", "synthetic": synthetic, "athletes": sorted({r["athlete_id"] for r in rows}),
                   "n_readings": len(rows), "first_ts": rows[0]["ts"] if rows else None,
                   "last_ts": rows[-1]["ts"] if rows else None, "aligned_to_plan_start": aligned},
        "plan_forecast": prior,
        "frames": frames,
        "hr_series": series,
        "labels": labels,
    }


# ── field node ───────────────────────────────────────────────────────────────

_POSTED: list[dict[str, Any]] = []


def _num(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if v != v else v  # NaN → None


def newest_node_csv() -> Optional[Path]:
    files = sorted(DATA.glob("node_*.csv")) if DATA.exists() else []
    return files[-1] if files else None


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
    path = newest_node_csv()
    if path is not None:
        rows = _read_node_csv(path)
        if rows:
            last = _reading(rows[-1])
            labels = [f"field node recording (data/{path.name})"]
            if not last["globe_calibrated"]:
                labels.append("globe thermistor uncalibrated")
            if last.get("air_source"):
                labels.append(f"air temperature / humidity from {last['air_source']}")
            if str(rows[-1].get("mode", "")).lower() == "replay":
                labels.append("replay")
            return {"reading": last, "series": _per_minute(rows), "file": f"data/{path.name}", "labels": labels}
    if _POSTED:
        last = _POSTED[-1]
        return {"reading": last, "series": _per_minute(_POSTED), "file": None,
                "labels": ["field node readings posted to this engine run"]
                + ([] if last.get("globe_calibrated") else ["globe thermistor uncalibrated"])}
    return {"reading": None, "series": [], "file": None, "labels": [NO_FIELD]}


def post_node(reading: Mapping[str, Any], forecast: Sequence[Mapping[str, Any]], lat: Optional[float],
              lon: Optional[float]) -> dict[str, Any]:
    from engine import weather

    hour = weather.node_hour(reading, forecast, lat, lon)
    row = {"ts": reading["ts"], "globe_c": _num(reading.get("globe_temp_c")), "air_c": _num(reading.get("air_temp_c")),
           "rh_pct": _num(reading.get("rh_pct")), "air_source": reading.get("air_source"),
           "globe_calibrated": bool(reading.get("globe_calibrated", False)),
           "tub_temp_c": _num(reading.get("tub_temp_c")),
           "node_wbgt_f": hour["wbgt_f"] if hour else None, "fhsaa_zone": hour["fhsaa_zone"] if hour else None}
    f = weather._interp(sorted(forecast, key=lambda h: twonode.parse_time(h["time"])), "wbgt_f",
                        twonode.parse_time(reading["ts"])) if hour else None
    row["forecast_wbgt_f"] = f
    row["field_minus_forecast_f"] = round(hour["wbgt_f"] - f, 1) if hour and f is not None else None
    _POSTED.append(row)
    return {"ok": True, "hour": hour}


def _clear_posted() -> None:  # tests
    _POSTED.clear()

