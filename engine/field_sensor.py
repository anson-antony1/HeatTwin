"""Field mode of the Arduino sideline node: its temperature is the field AIR temperature, NWS supplies the rest.

The box has one thermistor. In field mode (HEATTWIN_NODE_MODE=field, the default) the A0 reading is the air temperature
at the field; relative humidity, 10 m wind and sunlight for the moment of the reading come from live NWS for the site
(hourly values interpolated to the reading's time, as the physiology model reads weather); WBGT is engine/wbgt.py
(Liljegren) and the zone is engine/fhsaa.py. When NWS is unreachable, humidity / wind / cloud come from the pinned
forecast shifted so its pinned plan start lands on now (the same idea as api._live_session_weather) and the label says
so. The NWS fetch is cached in memory (constants.field_node.nws_cache_ttl_s) and refreshed in a background thread, so a
slow network never stalls the serial reader; nothing is written to fixtures/.

Labels (used verbatim by the API and the web chip):
    "Field sensor (Arduino) + NWS"
    "Field sensor (Arduino) + forecast snapshot (time-shifted)"
Not a certified WBGT meter: the thermistor is uncalibrated (nominal Beta) and, unshielded in the sun, reads above the
air temperature. The demo mode (HEATTWIN_NODE_MODE=demo, engine/node_bridge.DemoScenario) is unchanged.
"""
from __future__ import annotations

import math
import os
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Optional, Sequence

from engine import consts, fixtures, weather
from engine.physio import twonode

FIELD_NWS_LABEL = "Field sensor (Arduino) + NWS"
FIELD_SNAPSHOT_LABEL = "Field sensor (Arduino) + forecast snapshot (time-shifted)"
LIVE_NWS_LABEL = "live NWS forecast"
SNAPSHOT_LABEL = "forecast snapshot (time-shifted)"
THERMISTOR_LABEL = "air temperature from an uncalibrated thermistor (nominal Beta); in direct sun it reads above the air temperature"

_NWS, _SNAPSHOT = "nws", "snapshot"


def node_mode() -> str:
    """'field' (default) or 'demo' (HEATTWIN_NODE_MODE=demo: the indoor globe-as-sun scenario)."""
    return "demo" if os.environ.get("HEATTWIN_NODE_MODE", "field").strip().lower() == "demo" else "field"


def now() -> datetime:
    """Wall clock (tests replace this)."""
    return datetime.now().astimezone()


def plausible(air_c: Any) -> bool:
    """A thermistor temperature inside the wiring-fault gate (constants.field_node.air_c_min / air_c_max)."""
    try:
        v = float(air_c)
    except (TypeError, ValueError):
        return False
    return math.isfinite(v) and consts.get("field_node.air_c_min") <= v <= consts.get("field_node.air_c_max")


def label_for(weather_from: str) -> str:
    return FIELD_SNAPSHOT_LABEL if weather_from == _SNAPSHOT else FIELD_NWS_LABEL


# ── live NWS, cached in memory ───────────────────────────────────────────────

_lock = threading.Lock()
_cache: dict[tuple[float, float], dict[str, Any]] = {}
_gen = 0                                     # bumped by reset(): a fetch started before it must not write its result


def _mono() -> float:
    return time.monotonic()


def _key(lat: float, lon: float) -> tuple[float, float]:
    return (round(lat, 3), round(lon, 3))


def _fetch(lat: float, lon: float) -> list[dict[str, Any]]:
    """Hourly NWS rows (air, RH, wind, cloud) for a site. Raises on any network / parse failure. Not cached to disk."""
    raw, tz = weather.fetch_gridpoint(lat, lon)
    return sorted(weather.hours_from_gridpoint(raw, tz), key=lambda h: twonode.parse_time(h["time"]))


def _entry(key: tuple[float, float]) -> dict[str, Any]:
    return _cache.setdefault(key, {"hours": None, "at": None, "failed_at": None, "busy": False})


def _refresh(key: tuple[float, float], lat: float, lon: float, gen: int) -> Optional[list[dict[str, Any]]]:
    try:
        hours: Optional[list[dict[str, Any]]] = _fetch(lat, lon) or None
    except Exception:  # noqa: BLE001 — unreachable, HTTP error, or an unexpected payload: the snapshot is used
        hours = None
    with _lock:
        e = _entry(key)
        if gen != _gen:
            return hours
        e["busy"] = False
        if hours is not None:
            e.update(hours=hours, at=_mono(), failed_at=None)
        else:
            e.update(hours=None, failed_at=_mono())
        return e["hours"]


def nws_hours(lat: float, lon: float, *, wait: bool = False) -> Optional[list[dict[str, Any]]]:
    """Cached hourly NWS rows for a site, or None while NWS is unreachable / not fetched yet.

    Fresh for nws_cache_ttl_s; after that a refresh runs (in a background thread unless ``wait``) and the old rows are
    still returned until it finishes. A failed fetch is not retried for nws_retry_s. The rows carry no WBGT (the
    caller adds it where it needs it)."""
    key = _key(lat, lon)
    ttl, retry = float(consts.get("field_node.nws_cache_ttl_s")), float(consts.get("field_node.nws_retry_s"))
    with _lock:
        e, t = _entry(key), _mono()
        if e["hours"] is not None and t - e["at"] < ttl:
            return e["hours"]
        if e["failed_at"] is not None and t - e["failed_at"] < retry:
            return None
        gen = _gen
        if not wait:
            if not e["busy"]:
                e["busy"] = True
                threading.Thread(target=_refresh, args=(key, lat, lon, gen), name="heattwin-nws", daemon=True).start()
            return e["hours"]
    return _refresh(key, lat, lon, gen)


def nws_status(lat: float, lon: float) -> str:
    """'ok' (rows cached, or being refreshed), 'unreachable' (last fetch failed) or 'pending' (no fetch finished yet).
    Starts a background fetch when one is due; never blocks."""
    nws_hours(lat, lon)
    with _lock:
        e = _entry(_key(lat, lon))
        return "ok" if e["hours"] is not None else ("unreachable" if e["failed_at"] is not None else "pending")


def reset() -> None:
    """Forget the cache (tests, and a changed site)."""
    global _gen
    with _lock:
        _gen += 1
        _cache.clear()


# ── the pinned forecast, shifted to now ──────────────────────────────────────

def snapshot_hours(t0: datetime, pinned_start: Optional[str] = None) -> list[dict[str, Any]]:
    """The pinned forecast shifted so the pinned plan start (default: the fixture plan's) lands on ``t0`` — the same
    shift as a live session on the snapshot. Rows carry ``time_shifted_min``."""
    shift = t0 - twonode.parse_time(pinned_start or fixtures.plan()["start"])
    mins = round(shift.total_seconds() / 60.0)
    return [{**h, "time": (twonode.parse_time(h["time"]) + shift).isoformat(), "time_shifted_min": mins}
            for h in fixtures.forecast()]


# ── fusion ───────────────────────────────────────────────────────────────────

def _context(hours: Sequence[dict[str, Any]], t: datetime) -> Optional[dict[str, float]]:
    """Hourly rows interpolated to ``t`` (air, RH, wind, cloud); None when ``t`` is outside their span."""
    out = {k: weather._interp(hours, k, t) for k in ("air_temp_c", "rh_pct", "wind_m_s", "cloud_cover_pct")}
    return None if any(v is None for v in out.values()) else out  # type: ignore[return-value]


def fuse(air_c: float, t: datetime, lat: float, lon: float, *, use_nws: bool = True, wait: bool = False
         ) -> dict[str, Any]:
    """One Arduino air temperature at time ``t`` → a field WeatherHour (source "field_node") plus provenance.

    RH, 10 m wind and cloud are NWS's, interpolated to ``t``; sunlight is engine/wbgt.solar_from_cloud for those clouds
    at ``t``; WBGT is engine/wbgt.wbgt_f. ``weather_from`` is "nws", or "snapshot" when NWS is unreachable (or
    ``use_nws`` is False). ``forecast_wbgt_f`` is the same model on NWS's own air temperature, so the gap is the
    sensor's air temperature alone."""
    from engine import fhsaa_adapter, wbgt

    ctx = None
    src = _NWS
    hours = nws_hours(lat, lon, wait=wait) if use_nws else None
    if hours is not None:
        ctx = _context(hours, t)
    if ctx is None:
        src = _SNAPSHOT
        ctx = _context(snapshot_hours(t), t)
    assert ctx is not None, "the time-shifted snapshot always covers its own shift target"
    solar = float(wbgt.solar_from_cloud(lat, lon, t, ctx["cloud_cover_pct"]))
    w = round(float(wbgt.wbgt_f(air_c, ctx["rh_pct"], ctx["wind_m_s"], solar, lat, lon, t)), 1)
    fc = round(float(wbgt.wbgt_f(ctx["air_temp_c"], ctx["rh_pct"], ctx["wind_m_s"], solar, lat, lon, t)), 1)
    return {"time": t.isoformat(), "air_temp_c": round(float(air_c), 2), "rh_pct": round(ctx["rh_pct"], 1),
            "wind_m_s": round(ctx["wind_m_s"], 2), "cloud_cover_pct": round(ctx["cloud_cover_pct"], 1),
            "solar_w_m2": round(solar, 1), "wbgt_f": w, "fhsaa_zone": fhsaa_adapter.zone(w), "source": "field_node",
            "field_mode": True, "weather_from": src, "forecast_air_c": round(ctx["air_temp_c"], 2),
            "forecast_wbgt_f": fc}


def apply_air_temp(hours: Sequence[dict[str, Any]], air_c: float, lat: float, lon: float, t0: datetime, t1: datetime,
                   weather_from: str) -> list[dict[str, Any]]:
    """Hourly rows with the Arduino air temperature held across the plan window [t0, t1] (the rows the simulation
    reads), WBGT and zone recomputed from each row's own RH / wind / sunlight. Rows outside the window are unchanged.
    The changed rows are source "field_node", ``field_mode`` true, ``weather_from`` "nws" or "snapshot"."""
    from engine import fhsaa_adapter, wbgt

    out = []
    for h in hours:
        t = twonode.parse_time(h["time"])
        if t0 - timedelta(hours=1) < t <= t1 + timedelta(hours=1):
            solar = h.get("solar_w_m2")
            if solar is None:
                solar = wbgt.solar_from_cloud(lat, lon, t, h["cloud_cover_pct"])
            w = round(float(wbgt.wbgt_f(air_c, h["rh_pct"], h["wind_m_s"], solar, lat, lon, t)), 1)
            out.append({**h, "air_temp_c": round(float(air_c), 2), "solar_w_m2": round(float(solar), 1), "wbgt_f": w,
                        "fhsaa_zone": fhsaa_adapter.zone(w), "source": "field_node", "field_mode": True,
                        "weather_from": weather_from})
        else:
            out.append(dict(h))
    return out
