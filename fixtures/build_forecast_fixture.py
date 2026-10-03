"""Convert a cached NWS gridpoint response (api.weather.gov/gridpoints/{wfo}/{x},{y}) into a WeatherHour[] fixture.

Provenance only — WS1's engine/weather.py is the live path. Uses the NWS layers as published:
temperature, relativeHumidity, windSpeed (10 m), skyCover and wetBulbGlobeTemperature (NWS WBGT forecast).
solar_w_m2 is left out (NWS gives none); the physiology model computes it and labels that it did.

    python fixtures/build_forecast_fixture.py fixtures/nws_raw/<file>.json 2026-10-04T10:00:00-04:00 2026-10-04T20:00:00-04:00
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import consts, fhsaa_adapter  # noqa: E402

LAYERS = ("temperature", "relativeHumidity", "windSpeed", "skyCover", "wetBulbGlobeTemperature")


def _expand(layer: dict) -> dict[datetime, float]:
    out = {}
    for v in layer["values"]:
        start, dur = v["validTime"].split("/")
        t = datetime.fromisoformat(start)
        m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?", dur)
        hours = int(m.group(1) or 0) * 24 + int(m.group(2) or 0)
        for k in range(hours):
            out[t + timedelta(hours=k)] = v["value"]
    return out


def build(raw: dict, start: datetime, end: datetime) -> list[dict]:
    p = raw["properties"]
    assert p["windSpeed"]["uom"] == "wmoUnit:km_h-1" and p["temperature"]["uom"] == "wmoUnit:degC"
    assert p["wetBulbGlobeTemperature"]["uom"] == "wmoUnit:degC"
    lay = {k: _expand(p[k]) for k in LAYERS}
    ph = consts.get("physical")
    hours, t = [], start
    while t < end:
        tu = t.astimezone(datetime.fromisoformat(p["temperature"]["values"][0]["validTime"].split("/")[0]).tzinfo)
        wbgt_c = lay["wetBulbGlobeTemperature"][tu]
        wbgt_f = wbgt_c * ph["f_per_c"] + ph["f_offset"]
        hours.append({
            "time": t.isoformat(),
            "air_temp_c": round(lay["temperature"][tu], 2),
            "rh_pct": float(lay["relativeHumidity"][tu]),
            "wind_m_s": round(lay["windSpeed"][tu] * 1000.0 / ph["s_per_h"], 2),
            "cloud_cover_pct": float(lay["skyCover"][tu]),
            "wbgt_f": round(wbgt_f, 1),
            "fhsaa_zone": fhsaa_adapter.zone(round(wbgt_f, 1)),
            "source": "fixture",
        })
        t += timedelta(hours=1)
    return hours


if __name__ == "__main__":
    raw_path, start, end = sys.argv[1], datetime.fromisoformat(sys.argv[2]), datetime.fromisoformat(sys.argv[3])
    raw = json.loads(Path(raw_path).read_text())
    hours = build(raw, start, end)
    p = raw["properties"]
    out = {
        "synthetic": False,
        "note": "Cached NWS gridpoint forecast (not live). wbgt_f is the NWS wetBulbGlobeTemperature forecast layer, "
                "not computed by wbgt.py. solar_w_m2 absent (NWS provides none).",
        "provenance": {"url": raw.get("id") or raw_path, "nws_update_time": p.get("updateTime"),
                       "raw_file": str(Path(raw_path).name)},
        "hours": hours,
    }
    dest = Path(__file__).with_name(f"forecast_{start.date().isoformat()}.json")
    dest.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {dest} ({len(hours)} hours)")
