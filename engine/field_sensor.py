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
THERMISTOR_LABEL = ("air temperature from an uncalibrated thermistor (nominal Beta); in direct sun it reads above the air "
                    "temperature, so WBGT errs high")

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

def rh_at(rh_pct: float, from_c: float, to_c: float) -> float:
    """Relative humidity at ``to_c`` for the same water-vapour pressure as ``rh_pct`` at ``from_c`` (dewpoint held):
    a warmer sensor reading means drier air at the same moisture, not more moisture (physio-reviewer, Oct 4)."""
    return float(min(100.0, rh_pct * float(twonode.psat_mmhg(from_c)) / float(twonode.psat_mmhg(to_c))))


def gap_ok(gap_c: float) -> bool:
    return abs(gap_c) <= float(consts.get("field_node.max_forecast_gap_c"))

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
    rh = rh_at(ctx["rh_pct"], ctx["air_temp_c"], air_c)          # dewpoint held, not RH
    w = round(float(wbgt.wbgt_f(air_c, rh, ctx["wind_m_s"], solar, lat, lon, t)), 1)
    fc = round(float(wbgt.wbgt_f(ctx["air_temp_c"], ctx["rh_pct"], ctx["wind_m_s"], solar, lat, lon, t)), 1)
    gap = float(air_c) - ctx["air_temp_c"]
    return {"time": t.isoformat(), "air_temp_c": round(float(air_c), 2), "rh_pct": round(rh, 1),
            "forecast_rh_pct": round(ctx["rh_pct"], 1), "gap_c": round(gap, 2), "gap_ok": gap_ok(gap),
            "wind_m_s": round(ctx["wind_m_s"], 2), "cloud_cover_pct": round(ctx["cloud_cover_pct"], 1),
            "solar_w_m2": round(solar, 1), "wbgt_f": w, "fhsaa_zone": fhsaa_adapter.zone(w), "source": "field_node",
            "field_mode": True, "weather_from": src, "forecast_air_c": round(ctx["air_temp_c"], 2),
            "forecast_wbgt_f": fc}


def offset_at(hours: Sequence[dict[str, Any]], air_c: float, t_read: datetime) -> Optional[float]:
    """Sensor minus the base forecast's air temperature at the reading time (°C); None outside the rows' span."""
    base = weather._interp(hours, "air_temp_c", t_read)
    return None if base is None else float(air_c) - float(base)


def offset_label(offset_c: float, t_read: datetime) -> str:
    return (f"field sensor {offset_c:+.1f} °C vs the forecast at {t_read.strftime('%H:%M')}, applied to the forecast "
            "trend from then on (humidity at the same dewpoint)")


def apply_offset(hours: Sequence[dict[str, Any]], offset_c: float, t_read: datetime, lat: float, lon: float,
                 weather_from: str) -> list[dict[str, Any]]:
    """Hourly rows with the field sensor's offset from the forecast added to the forecast's air temperature from the
    reading time on — the forecast trend is kept (a warming morning stays warming), elapsed minutes are never rewritten
    (rows before ``t_read`` unchanged, plus a row at ``t_read`` with the forecast's own values), humidity re-derived at
    the same dewpoint, WBGT and zone recomputed. Changed rows are source "field_node", ``field_mode`` true."""
    from engine import fhsaa_adapter, wbgt

    def row(h: dict[str, Any], t: datetime, off: float, field: bool = True) -> dict[str, Any]:
        solar = h.get("solar_w_m2")
        if solar is None:
            solar = wbgt.solar_from_cloud(lat, lon, t, h["cloud_cover_pct"])
        air = float(h["air_temp_c"]) + off
        rh = rh_at(float(h["rh_pct"]), float(h["air_temp_c"]), air)
        w = round(float(wbgt.wbgt_f(air, rh, h["wind_m_s"], solar, lat, lon, t)), 1)
        out = {**h, "time": t.isoformat(), "air_temp_c": round(air, 2), "rh_pct": round(rh, 1),
               "solar_w_m2": round(float(solar), 1), "wbgt_f": w, "fhsaa_zone": fhsaa_adapter.zone(w)}
        if field:
            out.update(source="field_node", field_mode=True, weather_from=weather_from,
                       field_offset_c=round(off, 2))
        return out

    rows = sorted(hours, key=lambda h: twonode.parse_time(h["time"]))
    out = [dict(h) for h in rows if twonode.parse_time(h["time"]) <= t_read]
    ctx = _context(rows, t_read)
    if ctx is not None and not any(twonode.parse_time(h["time"]) == t_read for h in rows):
        out.append(row({**rows[0], **ctx, "solar_w_m2": None}, t_read, 0.0, field=False))   # the forecast at the reading
    out += [row(dict(h), twonode.parse_time(h["time"]), offset_c) for h in rows if twonode.parse_time(h["time"]) > t_read]
    return out
