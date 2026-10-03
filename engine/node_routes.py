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
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from engine import weather

router = APIRouter(tags=["sideline node"])

SITE = {"lat": 29.6516, "lon": -82.3248}       # demo field (fixtures/plan.json); one node, one site for now
MAX_READINGS = 6 * 60 * 30                     # 6 h at one reading every 2 s
FORECAST_TTL_S = 600

_readings: deque[dict[str, Any]] = deque(maxlen=MAX_READINGS)
_forecast: dict[str, Any] = {"hours": None, "at": 0.0}


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
    field = weather.node_hour(reading, _forecast_hours(), SITE["lat"], SITE["lon"])
    if field is None:
        raise HTTPException(422, "reading needs air_temp_c, rh_pct and globe_temp_c inside the forecast window")
    reading["_field"] = field
    _readings.append(reading)
    return {"ok": True, "field": field}


@router.get("/node/latest")
def node_latest() -> dict[str, Any]:
    if not _readings:
        raise HTTPException(404, "no node readings yet")
    last = _readings[-1]
    reading = {k: v for k, v in last.items() if k != "_field"}
    recent = [{k: v for k, v in x.items() if k != "_field"} for x in _readings]
    return {"reading": reading, "field": last["_field"],
            "assimilated": weather.assimilate_env(_forecast_hours(), recent, SITE["lat"], SITE["lon"]),
            "labels": _labels(last)}


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
    """Clear stored readings (tests)."""
    _readings.clear()


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
