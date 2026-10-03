"""NWS hourly forecast → WeatherHour[] (CONTRACTS.md).

Live path: api.weather.gov ``/points/{lat},{lon}`` → ``forecastGridData`` (the gridpoint raw layers that
the hourly forecast is generated from: temperature, relativeHumidity, windSpeed at 10 m, skyCover, plus
NWS's own wetBulbGlobeTemperature layer, kept as ``nws_wbgt_f`` for cross-checking ours).

Every live response is cached to ``fixtures/weather_cache/`` (raw gridpoint JSON + processed hours). If the
network fails, the newest cached forecast is loaded, then the curated demo fixture; those hours carry
``source="fixture"``. Live caches never overwrite the curated ``fixtures/forecast_<date>.json`` the demo uses.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo

from engine import consts, fixtures

API = "https://api.weather.gov"
USER_AGENT = "HeatTwin/0.1 (DTE Designathon; github.com/anson-antony1/HeatTwin)"  # NWS requires a User-Agent
CACHE_DIR = fixtures.FIXTURES / "weather_cache"
LAYERS = ("temperature", "relativeHumidity", "windSpeed", "skyCover", "wetBulbGlobeTemperature")

# unit of measure → converter to the WeatherHour field's unit
_TO_C = {"wmoUnit:degC": lambda v: v, "wmoUnit:degF": lambda v: (v - consts.get("physical.f_offset")) / consts.get("physical.f_per_c")}
_TO_M_S = {"wmoUnit:km_h-1": lambda v: v * 1000.0 / consts.get("physical.s_per_h"), "wmoUnit:m_s-1": lambda v: v}
_PERCENT = {"wmoUnit:percent": lambda v: v}
_CONVERT = {"temperature": _TO_C, "relativeHumidity": _PERCENT, "windSpeed": _TO_M_S, "skyCover": _PERCENT,
            "wetBulbGlobeTemperature": _TO_C}


# ── NWS fetch ────────────────────────────────────────────────────────────────

def _get_json(url: str, timeout: float) -> dict[str, Any]:
    import requests

    r = requests.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/geo+json"}, timeout=timeout)
    r.raise_for_status()
    return r.json()


def fetch_gridpoint(lat: float, lon: float, timeout: float = 10.0) -> tuple[dict[str, Any], str]:
    """(raw gridpoint JSON, IANA time zone) for a lat/lon. Raises on any network/HTTP error."""
    pts = _get_json(f"{API}/points/{lat:.4f},{lon:.4f}", timeout)["properties"]
    raw = _get_json(pts["forecastGridData"], timeout)
    return raw, pts.get("timeZone", "America/New_York")


# ── raw layers → hourly rows ────────────────────────────────────────────────

_DUR = re.compile(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?")


def _expand(layer: Mapping[str, Any]) -> dict[datetime, float]:
    """NWS ``validTime`` = "<start>/<ISO 8601 duration>"; expand to one value per UTC hour."""
    conv = _CONVERT_FOR(layer)
    out: dict[datetime, float] = {}
    for v in layer["values"]:
        if v["value"] is None:
            continue
        start, dur = v["validTime"].split("/")
        t = datetime.fromisoformat(start).astimezone(timezone.utc)
        m = _DUR.fullmatch(dur)
        if not m:
            raise ValueError(f"unparsed NWS duration {dur!r}")
        hours = int(m.group(1) or 0) * 24 + int(m.group(2) or 0) + (1 if int(m.group(3) or 0) else 0)
        for k in range(max(hours, 1)):
            out[t + timedelta(hours=k)] = conv(float(v["value"]))
    return out


def _CONVERT_FOR(layer: Mapping[str, Any]):
    uom = layer.get("uom")
    for table in _CONVERT.values():
        if uom in table:
            return table[uom]
    raise ValueError(f"unexpected NWS unit {uom!r}")


def hours_from_gridpoint(raw: Mapping[str, Any], tz: str = "America/New_York",
                         start: Optional[datetime] = None, end: Optional[datetime] = None,
                         source: str = "nws_forecast") -> list[dict[str, Any]]:
    """Gridpoint raw JSON → WeatherHour dicts (local-time ISO strings), hours where every core layer exists."""
    p = raw["properties"]
    lay = {k: _expand(p[k]) for k in LAYERS if k in p}
    core = ("temperature", "relativeHumidity", "windSpeed", "skyCover")
    missing = [k for k in core if k not in lay]
    if missing:
        raise ValueError(f"NWS gridpoint is missing layers {missing}")
    times = sorted(set.intersection(*(set(lay[k]) for k in core)))
    zone = ZoneInfo(tz)
    ph = consts.get("physical")
    rows = []
    for t in times:
        if start is not None and t < start.astimezone(timezone.utc):
            continue
        if end is not None and t >= end.astimezone(timezone.utc):
            continue
        row = {
            "time": t.astimezone(zone).isoformat(),
            "air_temp_c": round(lay["temperature"][t], 2),
            "rh_pct": round(lay["relativeHumidity"][t], 1),
            "wind_m_s": round(lay["windSpeed"][t], 2),
            "cloud_cover_pct": round(lay["skyCover"][t], 1),
            "source": source,
        }
        nws = lay.get("wetBulbGlobeTemperature", {}).get(t)
        if nws is not None:
            row["nws_wbgt_f"] = round(nws * ph["f_per_c"] + ph["f_offset"], 1)  # additive field: NWS's own WBGT
        rows.append(row)
    return rows


def add_wbgt(hours: list[dict[str, Any]], lat: float, lon: float) -> list[dict[str, Any]]:
    """Fill solar_w_m2, wbgt_f and fhsaa_zone. Uses engine.wbgt (Liljegren) when present, else NWS's WBGT layer."""
    from engine import fhsaa_adapter

    try:
        from engine import wbgt
    except ImportError:
        wbgt = None
    for h in hours:
        if wbgt is not None:
            t = datetime.fromisoformat(h["time"])
            if h.get("solar_w_m2") is None:
                h["solar_w_m2"] = round(float(wbgt.solar_from_cloud(lat, lon, t, h["cloud_cover_pct"])), 1)
            h["wbgt_f"] = round(float(wbgt.wbgt_f(h["air_temp_c"], h["rh_pct"], h["wind_m_s"], h["solar_w_m2"],
                                                   lat, lon, t)), 1)
        elif h.get("nws_wbgt_f") is not None:
            h["wbgt_f"] = h["nws_wbgt_f"]
        else:
            raise RuntimeError("no WBGT source: engine.wbgt missing and NWS gave no WBGT layer")
        h["fhsaa_zone"] = fhsaa_adapter.zone(h["wbgt_f"])
    return hours


# ── cache / fallback ─────────────────────────────────────────────────────────

def _cache(raw: Mapping[str, Any], hours: Sequence[Mapping[str, Any]], lat: float, lon: float, tz: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%MZ")
    raw_path = CACHE_DIR / f"nws_raw_{stamp[:10]}.json"  # one per day; newest fetch wins
    raw_path.write_text(json.dumps(raw) + "\n")
    out = {
        "synthetic": False,
        "note": "Cached live NWS gridpoint forecast written by engine/weather.py.",
        "provenance": {"url": raw.get("id"), "nws_update_time": raw.get("properties", {}).get("updateTime"),
                       "fetched_at": stamp, "lat": lat, "lon": lon, "time_zone": tz, "raw_file": raw_path.name},
        "hours": list(hours),
    }
    path = CACHE_DIR / f"forecast_{stamp[:10]}.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    return path


def newest_fixture() -> Path:
    """Newest cached live forecast, else the curated demo fixture."""
    cached = sorted(CACHE_DIR.glob("forecast_*.json"))
    if cached:
        return cached[-1]
    return fixtures.FIXTURES / fixtures.DEFAULT_FORECAST


def load_fixture(path: Optional[Path] = None) -> list[dict[str, Any]]:
    path = path or newest_fixture()
    hours = [dict(h) for h in json.loads(Path(path).read_text())["hours"]]
    for h in hours:
        h["source"] = "fixture"
    return hours


def get_forecast(lat: float, lon: float, start: Optional[datetime] = None, end: Optional[datetime] = None,
                 timeout: float = 10.0, offline: bool = False) -> list[dict[str, Any]]:
    """Hourly WeatherHour[] for a site. Live NWS when reachable (and cached); newest fixture otherwise."""
    if not offline:
        try:
            raw, tz = fetch_gridpoint(lat, lon, timeout)
            hours = add_wbgt(hours_from_gridpoint(raw, tz), lat, lon)
            _cache(raw, hours, lat, lon, tz)
            return _window(hours, start, end)
        except Exception:  # noqa: BLE001 — any network/parse failure falls back to the fixture
            pass
    return _window(load_fixture(), start, end)


def _window(hours, start, end):
    def keep(h):
        t = datetime.fromisoformat(h["time"])
        return (start is None or t >= start) and (end is None or t < end)
    return [h for h in hours if keep(h)]


# ── field-node assimilation (WS1 step 4) ────────────────────────────────────

def _interp(hours: Sequence[Mapping[str, Any]], key: str, t: datetime) -> Optional[float]:
    """Linear interpolation of an hourly field at t; None outside the forecast span."""
    ts = [datetime.fromisoformat(h["time"]).timestamp() for h in hours]
    x = t.timestamp()
    if not ts or x < ts[0] or x > ts[-1] + 3600:
        return None
    import numpy as np

    return float(np.interp(x, ts, [float(h[key]) for h in hours]))


def node_reading_wbgt(reading: Mapping[str, Any], forecast: Sequence[Mapping[str, Any]],
                      lat: Optional[float] = None, lon: Optional[float] = None) -> Optional[dict[str, Any]]:
    """Field WBGT for one node reading (CONTRACTS.md node shape), with the forecast at the same moment.

    The node has no anemometer (wind_m_s is null); the forecast's 10 m wind reduced to 2 m is used instead.
    Returns None if the reading lacks air/RH/globe temperature or falls outside the forecast.
    """
    from engine import wbgt

    if any(reading.get(k) is None for k in ("ts", "air_temp_c", "rh_pct", "globe_temp_c")):
        return None
    t = datetime.fromisoformat(reading["ts"])
    hours = sorted(forecast, key=lambda h: datetime.fromisoformat(h["time"]))
    f_wbgt, f_air = _interp(hours, "wbgt_f", t), _interp(hours, "air_temp_c", t)
    if f_wbgt is None:
        return None
    wind = reading.get("wind_m_s")
    if wind is None:                         # forecast 10 m wind → 2 m with Liljegren's stability power law
        inp = consts.get("wbgt_inputs")
        f_wind = _interp(hours, "wind_m_s", t)
        f_solar = _interp(hours, "solar_w_m2", t) if all(h.get("solar_w_m2") is not None for h in hours) else 0.0
        daytime = True
        if lat is not None and lon is not None:
            daytime = bool(wbgt.solar_geometry(wbgt._utc_seconds(t), lat, lon)[0][0] > 0)
        stab = wbgt.stability_class(daytime, f_wind, f_solar, inp["night_dt_c"])
        wind = float(wbgt.wind_at_2m(f_wind, inp["wind_height_m"], stab, inp["urban"]))
    kw = {"time": t, "lat": lat, "lon": lon} if lat is not None and lon is not None else {}
    node = wbgt.node_components(float(reading["air_temp_c"]), float(reading["rh_pct"]), float(reading["globe_temp_c"]),
                                wind, **kw)
    return {"t": t, "node_wbgt_f": node["wbgt_f"], "forecast_wbgt_f": f_wbgt, "node_air_c": float(reading["air_temp_c"]),
            "forecast_air_c": f_air, "rh_pct": float(reading["rh_pct"]), "wind_m_s": wind,
            "solar_w_m2": node["solar_inferred_w_m2"]}


def node_hour(reading: Mapping[str, Any], forecast: Sequence[Mapping[str, Any]],
              lat: Optional[float] = None, lon: Optional[float] = None) -> Optional[dict[str, Any]]:
    """The latest node reading as a WeatherHour (source="field_node") for GET /node/latest."""
    from engine import fhsaa_adapter

    r = node_reading_wbgt(reading, forecast, lat, lon)
    if r is None:
        return None
    cloud = _interp(sorted(forecast, key=lambda h: datetime.fromisoformat(h["time"])), "cloud_cover_pct", r["t"])
    w = round(r["node_wbgt_f"], 1)
    return {"time": r["t"].isoformat(), "air_temp_c": round(r["node_air_c"], 2), "rh_pct": round(r["rh_pct"], 1),
            "wind_m_s": round(r["wind_m_s"], 2), "cloud_cover_pct": round(cloud, 1) if cloud is not None else 0.0,
            "solar_w_m2": round(r["solar_w_m2"], 1), "wbgt_f": w, "fhsaa_zone": fhsaa_adapter.zone(w),
            "source": "field_node", "node_id": reading.get("node_id")}


def assimilate_env(forecast: Sequence[Mapping[str, Any]], node_readings: Sequence[Mapping[str, Any]],
                   lat: Optional[float] = None, lon: Optional[float] = None) -> list[dict[str, Any]]:
    """Forecast hours corrected by field-node readings (see constants.assimilation).

    * Hours containing readings → WBGT and air temperature are the mean of what the node measured
      (source="field_node").
    * Later hours → forecast + bias · max(0, 1 − Δt/decay_h), bias = mean(node − forecast) over the last
      window_min of readings (source="assimilated"; fields bias_wbgt_f / bias_air_c say by how much).
    * Earlier hours and hours past the decay horizon are returned unchanged.
    Pass the site lat/lon so the globe inversion can use sun angle (otherwise sunlight is treated as diffuse).
    """
    from engine import fhsaa_adapter

    cfg = consts.get("assimilation")
    hours = sorted((dict(h) for h in forecast), key=lambda h: datetime.fromisoformat(h["time"]))
    pts = [p for p in (node_reading_wbgt(r, hours, lat, lon) for r in node_readings) if p is not None]
    if not pts:
        return hours
    pts.sort(key=lambda p: p["t"])
    t_last = pts[-1]["t"]
    recent = [p for p in pts if (t_last - p["t"]).total_seconds() <= cfg["window_min"] * 60]
    bias_w = sum(p["node_wbgt_f"] - p["forecast_wbgt_f"] for p in recent) / len(recent)
    bias_a = sum(p["node_air_c"] - p["forecast_air_c"] for p in recent) / len(recent)

    for h in hours:
        t0 = datetime.fromisoformat(h["time"])
        in_hour = [p for p in pts if 0 <= (p["t"] - t0).total_seconds() < 3600]
        if in_hour:
            h["wbgt_f"] = round(sum(p["node_wbgt_f"] for p in in_hour) / len(in_hour), 1)
            h["air_temp_c"] = round(sum(p["node_air_c"] for p in in_hour) / len(in_hour), 2)
            h["n_node_readings"] = len(in_hour)
            h["source"] = "field_node"
        elif t0 > t_last:
            weight = max(0.0, 1.0 - (t0 - t_last).total_seconds() / 3600.0 / cfg["decay_h"])
            if weight <= 0:
                continue
            h["bias_wbgt_f"] = round(bias_w * weight, 2)
            h["bias_air_c"] = round(bias_a * weight, 2)
            h["wbgt_f"] = round(h["wbgt_f"] + bias_w * weight, 1)
            h["air_temp_c"] = round(h["air_temp_c"] + bias_a * weight, 2)
            h["source"] = "assimilated"
        else:
            continue
        h["fhsaa_zone"] = fhsaa_adapter.zone(h["wbgt_f"])
    return hours
