"""HTTP routes for the sideline node (CONTRACTS.md API: POST /node, GET /node/latest). Mount in engine/api.py:

    from engine import node_routes
    app.include_router(node_routes.router)

POST /node            node reading (CONTRACTS.md shape; engine/node_bridge.py sends it with --post)  → {ok, field}
GET  /node/latest     → {reading, field: WeatherHour (source "field_node"), assimilated: WeatherHour[], labels,
                         source: {id, label, mode, sensor_fresh, reading_age_s, stale_after_s}}   (source: v1.7)
GET  /node/history    ?minutes=60 → {readings: [{ts, globe_temp_c, air_temp_c, rh_pct, wbgt_f, fhsaa_zone}], labels}
GET  /node/status     → the built-in bridge's state (engine/node_autostart.py) + the same ``source``

Field mode (v1.7, the default; engine/field_sensor.py): a reading with ``mode: "field"`` carries only the Arduino's air
temperature; the engine adds NWS humidity / wind / sunlight (or the time-shifted pinned forecast) and computes WBGT.
``source`` says what a live session would use right now and how old the last Arduino reading is.

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

from engine import consts, field_sensor, weather

router = APIRouter(tags=["sideline node"])

SITE = {"lat": 29.6516, "lon": -82.3248}       # demo field (fixtures/plan.json); one node, one site for now
MAX_READINGS = 6 * 60 * 30                     # 6 h at one reading every 2 s
FORECAST_TTL_S = 600

DEMO_LABEL = "DEMO scenario: indoor globe heated to stand in for the sun (synthetic) — not field data"

_readings: deque[dict[str, Any]] = deque(maxlen=MAX_READINGS)
_forecast: dict[str, Any] = {"hours": None, "at": 0.0}
_demo: dict[str, Any] = {"reading": None, "received": 0.0, "solar": [], "version": 0, "solar_at_version": None}

# Set by engine/api.py: called after a demo reading changes the scenario enough; returns a re-forecast or None.
on_demo_update: Optional[Callable[[], Optional[dict[str, Any]]]] = None

# Field mode (engine/field_sensor.py): the latest Arduino air-temperature reading. ``received`` is wall-clock arrival, kept
# after an unplug so the age can still be shown; ``ended`` marks the board gone. ``version`` bumps when what a live session
# should use changes (sensor appeared / went away, NWS vs snapshot, air temperature moved).
_field: dict[str, Any] = {"reading": None, "received": 0.0, "ended": False, "version": 0, "air_at_version": None,
                          "from_at_version": None}

# Set by engine/api.py: called when that happens; re-runs a live session's weather chain and returns a re-forecast or None.
on_field_update: Optional[Callable[[], Optional[dict[str, Any]]]] = None


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


def _field_labels(reading: dict[str, Any]) -> list[str]:
    f = reading["_field"]
    nws = f["weather_from"] == "nws"
    return [field_sensor.label_for(f["weather_from"]), field_sensor.THERMISTOR_LABEL,
            ("humidity, wind and sunlight from live NWS" if nws else
             "NWS unreachable: humidity, wind and sunlight from the pinned forecast shifted to now") +
            "; WBGT computed by engine/wbgt.py — not a certified WBGT meter"]


def _labels(reading: dict[str, Any]) -> list[str]:
    if reading.get("mode") == "field":
        return _field_labels(reading)
    out = ["field WBGT from a 40 mm black-globe node — not a certified WBGT meter"]
    if reading.get("demo"):
        out.insert(0, DEMO_LABEL)
        g = reading.get("sun_gain")
        if g and float(g) != 1.0:
            out.insert(1, f"demo sensitivity: the globe's rise counts {float(g):g}× (fingertip stands in for full sun)")
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
    if reading.get("mode") == "field":
        return _post_field(reading)
    field = weather.node_hour(reading, _forecast_hours(), SITE["lat"], SITE["lon"])
    if field is None:
        raise HTTPException(422, "reading needs air_temp_c, rh_pct and globe_temp_c inside the forecast window")
    reading["_field"] = field
    _readings.append(reading)
    return {"ok": True, "field": field}


def _post_field(reading: dict[str, Any]) -> dict[str, Any]:
    """Field reading: the Arduino's air temperature + NWS humidity / wind / sunlight (field_sensor.fuse)."""
    if not field_sensor.plausible(reading.get("air_temp_c")):
        raise HTTPException(422, "field reading needs air_temp_c within constants.field_node.air_c_min..air_c_max")
    t = datetime.fromisoformat(reading["ts"])
    if t.tzinfo is None:
        raise HTTPException(422, "ts must be ISO 8601 with offset")
    f = field_sensor.fuse(float(reading["air_temp_c"]), t, SITE["lat"], SITE["lon"])
    reading.update(rh_pct=f["rh_pct"], wind_m_s=f["wind_m_s"], weather_from=f["weather_from"],
                   air_source=reading.get("air_source") or "arduino_a0", globe_calibrated=False)
    reading["_field"] = {**f, "node_id": reading.get("node_id")}
    _readings.append(reading)
    changed = _note_field(reading)
    out: dict[str, Any] = {"ok": True, "field": reading["_field"], "labels": _labels(reading), "source": source_info()}
    if changed:
        ref = _run_field_hook()
        if ref is not None:
            out["reforecast"] = ref
    return out


def _note_field(reading: dict[str, Any]) -> bool:
    """Remember the latest field reading; True when a live session should refresh its weather."""
    was_active = field_active()
    f = reading["_field"]
    moved = (_field["air_at_version"] is None
             or abs(f["air_temp_c"] - _field["air_at_version"]) >= consts.get("field_node.reforecast_min_change_c"))
    changed = (not was_active) or moved or f["weather_from"] != _field["from_at_version"]
    _field.update(reading=reading, received=time.time(), ended=False)
    if changed:
        _field.update(version=_field["version"] + 1, air_at_version=f["air_temp_c"], from_at_version=f["weather_from"])
    return changed


def _run_field_hook() -> Optional[dict[str, Any]]:
    if on_field_update is None:
        return None
    try:
        return on_field_update()
    except Exception as e:  # noqa: BLE001 — a failed re-forecast must never stop the serial reader
        print(f"[node] live-session weather refresh failed: {type(e).__name__}: {e}", flush=True)
        return None


def end_field() -> None:
    """The Arduino went away (unplugged, port lost, silent): stop using its reading now instead of after stale_after_s,
    and let a running live session fall back to live NWS / the snapshot."""
    if _field["reading"] is None or _field["ended"]:
        return
    _field.update(ended=True, version=_field["version"] + 1)
    _run_field_hook()


def _expire_field() -> None:
    """A reading that just stopped arriving with no unplug event (an external bridge died, a hung board): once it is older
    than stale_after_s treat the board as gone, so a running live session falls back like it does on an unplug."""
    age = field_age_s()
    if age is not None and not _field["ended"] and age >= consts.get("field_node.stale_after_s"):
        end_field()


def field_age_s() -> Optional[float]:
    """Seconds since the last field (Arduino) reading arrived; None if none has."""
    return None if _field["reading"] is None else round(max(0.0, time.time() - _field["received"]), 1)


def field_active() -> bool:
    """A field reading arrived within constants.field_node.stale_after_s and the board has not been unplugged."""
    age = field_age_s()
    return age is not None and not _field["ended"] and age < consts.get("field_node.stale_after_s")


def field_reading(include_rejected: bool = False) -> Optional[dict[str, Any]]:
    """The fresh field reading (raw fields + ``_field``), else None — what a live session's weather chain asks for. A
    reading further than constants.field_node.max_forecast_gap_c from the forecast is not used (mis-sited box) unless
    ``include_rejected`` (the chain asks, to say why it isn't used)."""
    r = _field["reading"] if field_active() else None
    return r if r is not None and (include_rejected or r["_field"].get("gap_ok", True)) else None


def source_info() -> dict[str, Any]:
    """Which weather a live session would use right now and how old the Arduino's last reading is (v1.7).

    id: "field_sensor_nws" | "field_sensor_snapshot" (fresh Arduino reading) | "demo_scenario" | "nws" | "snapshot"
    (no fresh reading: live NWS if reachable, else the pinned forecast shifted to now) | "none" (no sensor path)."""
    from engine import node_autostart

    _expire_field()
    mode, stale = field_sensor.node_mode(), consts.get("field_node.stale_after_s")
    base = {"mode": mode, "stale_after_s": stale}
    if demo_active():
        return {**base, "id": "demo_scenario", "label": DEMO_LABEL, "sensor_fresh": True,
                "reading_age_s": round(max(0.0, time.time() - _demo["received"]), 1)}
    fresh, age = field_active(), field_age_s()
    if fresh and not _field["reading"]["_field"].get("gap_ok", True):
        f = _field["reading"]["_field"]
        ok = field_sensor.nws_status(SITE["lat"], SITE["lon"]) == "ok"
        return {**base, "id": "nws" if ok else "snapshot", "sensor_fresh": True, "reading_age_s": age,
                "label": (f"{field_sensor.LIVE_NWS_LABEL if ok else field_sensor.SNAPSHOT_LABEL} — field sensor "
                          f"{f['gap_c']:+.1f} °C from the forecast, not used")}
    if fresh:
        src = _field["reading"]["_field"]["weather_from"]
        return {**base, "id": f"field_sensor_{src}", "label": field_sensor.label_for(src), "sensor_fresh": True,
                "reading_age_s": age}
    if age is None and not node_autostart.status()["enabled"]:
        return {**base, "id": "none", "label": None, "sensor_fresh": False, "reading_age_s": None}
    ok = field_sensor.nws_status(SITE["lat"], SITE["lon"]) == "ok"
    return {**base, "id": "nws" if ok else "snapshot",
            "label": field_sensor.LIVE_NWS_LABEL if ok else field_sensor.SNAPSHOT_LABEL,
            "sensor_fresh": False, "reading_age_s": age}


def _post_demo(reading: dict[str, Any]) -> dict[str, Any]:
    """Demo reading (constants.demo_node): WBGT straight from the globe inversion; no forecast window needed."""
    from engine import fhsaa, wbgt

    if any(reading.get(k) is None for k in ("air_temp_c", "rh_pct", "globe_temp_c")):
        raise HTTPException(422, "demo reading needs air_temp_c, rh_pct and globe_temp_c")
    n = wbgt.node_components(reading["air_temp_c"], reading["rh_pct"], reading["globe_temp_c"], reading.get("wind_m_s"))
    w = round(n["wbgt_f"], 1)
    field = {"time": reading["ts"], "air_temp_c": round(reading["air_temp_c"], 2), "rh_pct": reading["rh_pct"],
             "wind_m_s": reading.get("wind_10m_m_s") or consts.get("demo_node.wind_10m_m_s"), "cloud_cover_pct": 0.0,
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


def end_demo() -> None:
    """The node went away (unplugged): stop using its scenario weather now instead of after stale_after_s."""
    if _demo["reading"] is not None:
        _demo["received"] = 0.0


@router.get("/node/status")
def node_status() -> dict[str, Any]:
    """What the engine's built-in bridge is doing (engine/node_autostart.py): waiting / connected / port_unavailable."""
    from engine import node_autostart

    return {**node_autostart.status(), "demo_active": demo_active(), "source": source_info()}


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
    if x.get("mode") == "field":       # air temperature + NWS: the reference is the same model on NWS's own air temperature
        return {"globe_c": None, "air_c": f["air_temp_c"], "node_wbgt_f": f["wbgt_f"],
                "forecast_wbgt_f": f["forecast_wbgt_f"], "field_minus_forecast_f": round(f["wbgt_f"] - f["forecast_wbgt_f"], 1),
                "fhsaa_zone": f["fhsaa_zone"], "globe_calibrated": False, "tub_temp_c": x.get("tub_temp_c")}
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
    {reading: null, labels: ["no field recording yet"]} — never placeholder numbers.
    v1.7: every answer also carries ``source`` (see source_info)."""
    return {**_node_latest(), "source": source_info()}


def _field_assimilated(last: dict[str, Any]) -> list[dict[str, Any]]:
    """Field mode: the next 3 h of hourly weather with the Arduino's offset from the forecast applied to the forecast
    trend (what a live session would use); none when the reading is too far from the forecast to use."""
    now = field_sensor.now()
    f = last["_field"]
    base = field_sensor.nws_hours(SITE["lat"], SITE["lon"]) if f["weather_from"] == "nws" else None
    src = "nws" if base else "snapshot"
    rows = base or field_sensor.snapshot_hours(now)
    t_read = datetime.fromisoformat(last["ts"])
    off = field_sensor.offset_at(rows, f["air_temp_c"], t_read)
    if off is None or not field_sensor.gap_ok(off):
        return []
    hours = field_sensor.apply_offset(rows, off, t_read, SITE["lat"], SITE["lon"], src)
    return [h for h in hours if h.get("field_mode") and datetime.fromisoformat(h["time"]) <= now + timedelta(hours=3)]


def _node_latest() -> dict[str, Any]:
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
    if last.get("mode") == "field":
        return {"reading": reading, "field": last["_field"], "assimilated": _field_assimilated(last),
                "labels": _labels(last), "series": _series([x for x in _readings if x.get("mode") == "field"]),
                "file": None}
    globe = [x for x in _readings if not x.get("demo") and x.get("mode") != "field"]
    recent = [{k: v for k, v in x.items() if k != "_field"} for x in globe]
    return {"reading": reading, "field": last["_field"],
            "assimilated": weather.assimilate_env(_forecast_hours(), recent, SITE["lat"], SITE["lon"]),
            "labels": _labels(last), "series": _series(globe), "file": None}


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
    _field.update(reading=None, received=0.0, ended=False, version=0, air_at_version=None, from_at_version=None)


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
