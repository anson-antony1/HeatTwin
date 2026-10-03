"""HTTP routes for the sideline node (CONTRACTS.md API: POST /node, GET /node/latest). Mount in engine/api.py:

    from engine import node_routes
    app.include_router(node_routes.router)

POST /node            node reading (CONTRACTS.md shape; engine/node_bridge.py sends it with --post)  → {ok, field}
GET  /node/latest     → {reading, field: WeatherHour (source "field_node"), assimilated: WeatherHour[], labels}
GET  /node/history    ?minutes=60 → {readings: [{ts, globe_temp_c, air_temp_c, rh_pct, wbgt_f, fhsaa_zone}], labels}

The web app's field card reads ``field.wbgt_f`` / ``field.fhsaa_zone`` (and ``labels``) from /node/latest; the
remaining forecast corrected by the field readings is ``assimilated`` (weather.assimilate_env), which /simulate can
take as ``weather``. Readings are kept in memory (the bridge also logs every one to data/node_<date>.csv).
"""
from __future__ import annotations

import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from engine import consts, weather

router = APIRouter(tags=["sideline node"])

SITE = {"lat": 29.6516, "lon": -82.3248}       # demo field (fixtures/plan.json); one node, one site for now
MAX_READINGS = 6 * 60 * 30                     # 6 h at one reading every 2 s
FORECAST_TTL_S = 600

DEMO_LABEL = "DEMO scenario: indoor globe on a hot-day scenario (synthetic) — not field data"

_readings: deque[dict[str, Any]] = deque(maxlen=MAX_READINGS)
_forecast: dict[str, Any] = {"hours": None, "at": 0.0}
_demo: dict[str, Any] = {"reading": None, "received": 0.0, "solar": [], "version": 0, "solar_at_version": None}

# Set by engine/api.py: called after a demo reading changes the scenario enough; returns a re-forecast or None.
on_demo_update: Optional[Callable[[], Optional[dict[str, Any]]]] = None


class NodeReading(BaseModel):
    model_config = ConfigDict(extra="allow")   # additive fields (air_source, globe_calibrated, ...) are kept
    node_id: str
    ts: str
    air_temp_c: Optional[float] = None
    rh_pct: Optional[float] = Field(default=None, ge=0, le=100)
    globe_temp_c: Optional[float] = None
    tub_temp_c: Optional[float] = None
    wind_m_s: Optional[float] = None
    battery_v: Optional[float] = None


def _forecast_hours() -> list[dict[str, Any]]:
    if _forecast["hours"] is None or time.time() - _forecast["at"] > FORECAST_TTL_S:
        _forecast["hours"] = weather.get_forecast(SITE["lat"], SITE["lon"])
        _forecast["at"] = time.time()
    return _forecast["hours"]


def _labels(reading: dict[str, Any]) -> list[str]:
    out = ["field WBGT from a 40 mm black-globe node — not a certified WBGT meter"]
    if reading.get("demo"):
        out.insert(0, DEMO_LABEL)
    if reading.get("globe_calibrated") is False:
        out.append("globe thermistor uncalibrated")
    src = reading.get("air_source")
    if src and src != "node_a1":
        out.append(f"air temperature/humidity from {src.replace('_', ' ')}, not measured at the field")
    if any(h.get("source") == "fixture" for h in (_forecast["hours"] or [])):
        out.append("forecast is fixture")
    return out


@router.post("/node")
def post_node(r: NodeReading) -> dict[str, Any]:
    reading = r.model_dump()
    try:
        datetime.fromisoformat(reading["ts"])
    except ValueError as e:
        raise HTTPException(422, "ts must be ISO 8601 with offset") from e
    if reading.get("demo"):
        return _post_demo(reading)
    field = weather.node_hour(reading, _forecast_hours(), SITE["lat"], SITE["lon"])
    if field is None:
        raise HTTPException(422, "reading needs air_temp_c, rh_pct and globe_temp_c inside the forecast window")
    reading["_field"] = field
    _readings.append(reading)
    return {"ok": True, "field": field}


def _post_demo(reading: dict[str, Any]) -> dict[str, Any]:
    """Demo reading (constants.demo_node): WBGT straight from the globe inversion; no forecast window needed."""
    from engine import fhsaa, wbgt

    if any(reading.get(k) is None for k in ("air_temp_c", "rh_pct", "globe_temp_c")):
        raise HTTPException(422, "demo reading needs air_temp_c, rh_pct and globe_temp_c")
    n = wbgt.node_components(reading["air_temp_c"], reading["rh_pct"], reading["globe_temp_c"], reading.get("wind_m_s"))
    w = round(n["wbgt_f"], 1)
    field = {"time": reading["ts"], "air_temp_c": round(reading["air_temp_c"], 2), "rh_pct": reading["rh_pct"],
             "wind_m_s": consts.get("demo_node.wind_10m_m_s"), "cloud_cover_pct": 0.0,
             "solar_w_m2": round(n["solar_inferred_w_m2"], 1), "wbgt_f": w, "fhsaa_zone": fhsaa.zone(w),
             "source": "field_node", "node_id": reading.get("node_id"), "synthetic": True}
    reading["_field"] = field
    _readings.append(reading)
    _demo["reading"], _demo["received"] = reading, time.time()
    _demo["solar"] = (_demo["solar"] + [n["solar_inferred_w_m2"]])[-3:]          # light smoothing
    out: dict[str, Any] = {"ok": True, "field": field, "labels": _labels(reading), "demo_version": _demo["version"]}
    s_now = sum(_demo["solar"]) / len(_demo["solar"])
    last = _demo["solar_at_version"]
    if last is None or abs(s_now - last) >= consts.get("demo_node.reforecast_min_change_w_m2"):
        _demo["version"] += 1
        _demo["solar_at_version"] = s_now
        out["demo_version"] = _demo["version"]
        if on_demo_update is not None:
            ref = on_demo_update()
            if ref is not None:
                out["reforecast"] = ref
    return out


def demo_active() -> bool:
    return _demo["reading"] is not None and time.time() - _demo["received"] < consts.get("demo_node.stale_after_s")


def demo_version() -> int:
    """Bumps whenever the demo scenario changes enough to change results (for caches keyed on requests)."""
    return _demo["version"] if demo_active() else 0


def demo_weather(t0: datetime, t1: datetime) -> Optional[list[dict[str, Any]]]:
    """Hourly scenario weather covering [t0, t1] from the latest demo readings, or None when no demo is running.

    Air/RH/wind from the scenario, sunlight = the globe-inferred irradiance (smoothed), so the physiology model sees
    the heat gun as sun. The plan's own clock sets the sun angle, so run the demo on a daytime plan.
    """
    if not demo_active():
        return None
    r, f = _demo["reading"], _demo["reading"]["_field"]
    solar = sum(_demo["solar"]) / len(_demo["solar"])
    start = t0.replace(minute=0, second=0, microsecond=0)
    hours, t = [], start
    while t <= t1 + timedelta(hours=1):
        hours.append({"time": t.isoformat(), "air_temp_c": r["air_temp_c"], "rh_pct": r["rh_pct"],
                      "wind_m_s": f["wind_m_s"], "cloud_cover_pct": 0.0, "solar_w_m2": round(solar, 1),
                      "wbgt_f": f["wbgt_f"], "fhsaa_zone": f["fhsaa_zone"], "source": "field_node", "synthetic": True})
        t += timedelta(hours=1)
    return hours


def _v13(x: dict[str, Any]) -> dict[str, Any]:
    """CONTRACTS v1.3 NodeLatest.reading fields (what the web reads), added to the raw reading."""
    f = x["_field"]
    fc = None
    if not x.get("demo") and _forecast["hours"]:
        hours = sorted(_forecast["hours"], key=lambda h: datetime.fromisoformat(h["time"]))
        fc = weather._interp(hours, "wbgt_f", datetime.fromisoformat(x["ts"]))
    return {"globe_c": x.get("globe_temp_c"), "air_c": x.get("air_temp_c"), "node_wbgt_f": f["wbgt_f"],
            "forecast_wbgt_f": None if fc is None else round(fc, 1),
            "field_minus_forecast_f": None if fc is None else round(f["wbgt_f"] - fc, 1),
            "fhsaa_zone": f["fhsaa_zone"], "globe_calibrated": bool(x.get("globe_calibrated", False)),
            "tub_temp_c": x.get("tub_temp_c")}


def _series(rows) -> list[dict[str, Any]]:
    by_min: dict[str, dict[str, Any]] = {}
    for x in rows:
        by_min[str(x["ts"])[:16]] = x
    return [{"ts": x["ts"], "node_wbgt_f": x["_field"]["wbgt_f"], "forecast_wbgt_f": _v13(x)["forecast_wbgt_f"]}
            for x in by_min.values()]


@router.get("/node/latest")
def node_latest() -> dict[str, Any]:
    """Latest reading (raw fields + CONTRACTS v1.3 fields), field WeatherHour, assimilated forecast and labels.

    With no readings in this engine run: the newest data/node_<date>.csv (engine/demo_data.py), else
    {reading: null, labels: ["no field recording yet"]} — never placeholder numbers."""
    if not _readings:
        from engine import demo_data
        return demo_data.node_latest()
    last = _readings[-1]
    reading = {**{k: v for k, v in last.items() if k != "_field"}, **_v13(last)}
    if last.get("demo"):
        now = datetime.now(timezone.utc).astimezone()
        hours = demo_weather(now, now + timedelta(hours=3)) or []
        return {"reading": reading, "field": last["_field"], "assimilated": hours, "labels": _labels(last),
                "demo_version": demo_version(), "series": _series([x for x in _readings if x.get("demo")]),
                "file": None}
    recent = [{k: v for k, v in x.items() if k != "_field"} for x in _readings if not x.get("demo")]
    return {"reading": reading, "field": last["_field"],
            "assimilated": weather.assimilate_env(_forecast_hours(), recent, SITE["lat"], SITE["lon"]),
            "labels": _labels(last), "series": _series([x for x in _readings if not x.get("demo")]), "file": None}


@router.get("/node/history")
def node_history(minutes: float = Query(60, gt=0, le=24 * 60)) -> dict[str, Any]:
    if not _readings:
        return {"readings": [], "labels": []}
    cutoff = datetime.fromisoformat(_readings[-1]["ts"]) - timedelta(minutes=minutes)
    rows = [{"ts": x["ts"], "globe_temp_c": x.get("globe_temp_c"), "air_temp_c": x.get("air_temp_c"),
             "rh_pct": x.get("rh_pct"), "wbgt_f": x["_field"]["wbgt_f"], "fhsaa_zone": x["_field"]["fhsaa_zone"]}
            for x in _readings if datetime.fromisoformat(x["ts"]) >= cutoff]
    return {"readings": rows, "labels": _labels(_readings[-1])}


def reset() -> None:
    """Clear stored readings and demo state (tests)."""
    _readings.clear()
    _demo.update({"reading": None, "received": 0.0, "solar": [], "version": 0, "solar_at_version": None})


def standalone_app():
    """The node routes on their own, until /integrate mounts them in engine/api.py:

        uvicorn engine.node_routes:standalone_app --factory --port 8000
    """
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware

    app = FastAPI(title="HeatTwin sideline node")
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(router)
    return app
