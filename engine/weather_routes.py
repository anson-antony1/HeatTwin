"""Live field conditions for the web app (Settings → location, bottom-left field card).

GET /weather?lat=..&lon=..&date=YYYY-MM-DD
  → {lat, lon, place, source, now, next_hours[], day[], fetched_at, labels}

Wraps WS1's engine/weather.py (NWS gridpoint forecast + our Liljegren WBGT + FHSAA zone per hour). NWS covers
the US only; anywhere else (or offline) WS1 falls back to the cached fixture and ``source`` says so. Results are
memoised per location for a few minutes so the browser can poll without hammering api.weather.gov.
"""
from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Query

from engine import weather as ws1

router = APIRouter(tags=["weather"])

TTL_S = 600
_cache: dict[tuple[float, float], tuple[float, list[dict[str, Any]], Optional[str]]] = {}


def _place(lat: float, lon: float) -> Optional[str]:
    """'City, ST' from NWS /points relativeLocation (None if unavailable)."""
    try:
        props = ws1._get_json(f"{ws1.API}/points/{lat:.4f},{lon:.4f}", 6.0)["properties"]
        rel = props.get("relativeLocation", {}).get("properties", {})
        if rel.get("city"):
            return f"{rel['city']}, {rel.get('state', '')}".strip(", ")
    except Exception:  # noqa: BLE001 — name is cosmetic
        pass
    return None


def _hours(lat: float, lon: float) -> tuple[list[dict[str, Any]], Optional[str]]:
    key = (round(lat, 3), round(lon, 3))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < TTL_S:
        return hit[1], hit[2]
    hours = [dict(h) for h in ws1.get_forecast(lat, lon)]
    live = any(h.get("source") != "fixture" for h in hours)
    place = _place(lat, lon) if live else None
    _cache[key] = (time.time(), hours, place)
    return hours, place


def _t(h: dict[str, Any]) -> datetime:
    return datetime.fromisoformat(h["time"])


@router.get("/weather")
def weather(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    date: Optional[str] = Query(default=None, description="YYYY-MM-DD local; returns that day's hours as `day`"),
) -> dict[str, Any]:
    hours, place = _hours(lat, lon)
    if not hours:
        return {"lat": lat, "lon": lon, "place": place, "source": "none", "now": None, "next_hours": [], "day": [],
                "labels": ["no forecast available"]}

    live = any(h.get("source") != "fixture" for h in hours)
    tz = _t(hours[0]).tzinfo
    now = datetime.now(tz)
    # The forecast hour that contains "now" (or the nearest one if now is outside the window).
    current = min(hours, key=lambda h: abs((_t(h) - now).total_seconds() - 1800))
    upcoming = [h for h in hours if _t(h) >= _t(current)][:12]
    day = [h for h in hours if h["time"][:10] == date] if date else []

    labels = ["NWS hourly forecast; WBGT computed with the Liljegren model"] if live else [
        "forecast is fixture (NWS unreachable or location outside the US)"]
    return {
        "lat": lat,
        "lon": lon,
        "place": place,
        "source": "nws_forecast" if live else "fixture",
        "now": current,
        "next_hours": upcoming,
        "day": day,
        "fetched_at": datetime.now(tz).isoformat(timespec="seconds"),
        "labels": labels,
    }
