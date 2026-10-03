"""Sideline node bridge: Arduino Uno over USB serial → field WBGT → data/node_<date>.csv (and optionally POST /node).

The Uno (firmware/thermistor_test) prints ``ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c`` every 2 s.
Hackathon build: only the black-globe thermistor is wired. So for each reading this adds:
  * air temperature, RH and wind from the nearest NWS station's latest observation (KGNV, Gainesville airport),
    refreshed every 10 min — real measurements, but from the airport, not the field (``air_source`` column);
    if the station is unreachable, the hourly NWS forecast at that time (``air_source=nws_forecast``);
  * with ``--use-a1``, a shaded-air thermistor on A1 instead (``air_source=node_a1``); A1 is ignored otherwise.
The globe thermistor is **uncalibrated** (nominal Beta, see firmware/README.md); every row says so.

Field WBGT uses engine/wbgt.py's globe inversion (weather.node_reading_wbgt) and is logged next to the forecast WBGT
for the same minute.

    python -m engine.node_bridge --port /dev/ttyACM0                    # live, log to data/
    python -m engine.node_bridge --port /dev/ttyACM0 --post http://localhost:8000/node
    python -m engine.node_bridge --replay data/node_2026-10-03.raw.txt     # re-run saved serial output
"""
from __future__ import annotations

import argparse
import csv
import math
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

from engine import weather

SITE = {"lat": 29.6516, "lon": -82.3248}     # demo field (fixtures/plan.json site)
STATION = "KGNV"
OBS_REFRESH_S = 600
DATA_DIR = Path(__file__).resolve().parents[1] / "data"
FIELDS = ["ts", "globe_c", "globe_ohm", "air_c", "rh_pct", "wind_m_s", "air_source", "node_wbgt_f", "forecast_wbgt_f",
          "field_minus_forecast_f", "fhsaa_zone", "solar_inferred_w_m2", "globe_calibrated", "mode"]


# ── serial lines ─────────────────────────────────────────────────────────────

def parse_line(line: str) -> Optional[dict[str, float]]:
    """One sketch CSV line → {globe_c, globe_ohm, air_c}; None for comments, the header, or a missing globe."""
    line = line.strip()
    if not line or line.startswith("#") or line.startswith("ms,"):
        return None
    parts = line.split(",")
    if len(parts) != 7:
        return None
    try:
        vals = [float(p) for p in parts]          # "nan" parses to float nan
    except ValueError:
        return None
    _, _, g_ohm, g_c, _, _, a_c = vals
    if math.isnan(g_c):
        return None
    return {"globe_c": g_c, "globe_ohm": g_ohm, "air_c": a_c}


# ── air temperature / humidity source ───────────────────────────────────────

class AirSource:
    """Latest NWS station observation (cached), falling back to the hourly forecast."""

    def __init__(self, forecast: list[dict[str, Any]], station: str = STATION, offline: bool = False,
                 use_a1: bool = False):
        # use_a1: only when a shaded air thermistor is really wired to A1 — an unconnected analog pin floats and
        # reads a plausible-looking but meaningless temperature.
        self.forecast, self.station, self.offline, self.use_a1 = forecast, station, offline, use_a1
        self._obs: Optional[dict[str, Any]] = None
        self._fetched = 0.0

    def _station_obs(self) -> Optional[dict[str, Any]]:
        if self.offline:
            return None
        if self._obs is None or time.time() - self._fetched > OBS_REFRESH_S:
            try:
                import requests

                p = requests.get(f"{weather.API}/stations/{self.station}/observations/latest",
                                 headers={"User-Agent": weather.USER_AGENT}, timeout=8).json()["properties"]
                t, rh = p["temperature"]["value"], p["relativeHumidity"]["value"]
                wind = p["windSpeed"]["value"]
                if t is None or rh is None:
                    raise ValueError("station observation missing temperature/RH")
                self._obs = {"air_c": float(t), "rh_pct": float(rh),
                             "wind_m_s": float(wind) / 3.6 if wind is not None else None,  # km/h → m/s
                             "observed_at": p["timestamp"]}
                self._fetched = time.time()
            except Exception:  # noqa: BLE001 — keep logging the globe even if NWS is unreachable
                self._fetched = time.time()       # don't hammer NWS; retry after the refresh interval
        return self._obs

    def at(self, t: datetime, node_air_c: float) -> dict[str, Any]:
        obs = self._station_obs()
        if self.use_a1 and not math.isnan(node_air_c):
            rh = obs["rh_pct"] if obs else weather._interp(self.forecast, "rh_pct", t)
            return {"air_c": node_air_c, "rh_pct": rh, "wind_m_s": None, "air_source": "node_a1"}
        if obs:
            return {**obs, "air_source": f"nws_station_{self.station}"}
        return {"air_c": weather._interp(self.forecast, "air_temp_c", t),
                "rh_pct": weather._interp(self.forecast, "rh_pct", t), "wind_m_s": None, "air_source": "nws_forecast"}


# ── one reading → one row ────────────────────────────────────────────────────

def make_row(raw: dict[str, float], t: datetime, air: AirSource, mode: str) -> Optional[dict[str, Any]]:
    from engine import fhsaa

    a = air.at(t, raw["air_c"])
    if a["air_c"] is None or a["rh_pct"] is None:
        return None
    reading = {"node_id": "node-1", "ts": t.isoformat(), "air_temp_c": a["air_c"], "rh_pct": a["rh_pct"],
               "globe_temp_c": raw["globe_c"], "wind_m_s": a.get("wind_m_s")}
    r = weather.node_reading_wbgt(reading, air.forecast, SITE["lat"], SITE["lon"])
    if r is None:
        return None
    return {"ts": t.isoformat(timespec="seconds"), "globe_c": round(raw["globe_c"], 2), "globe_ohm": round(raw["globe_ohm"]),
            "air_c": round(a["air_c"], 2), "rh_pct": round(a["rh_pct"], 1), "wind_m_s": round(r["wind_m_s"], 2),
            "air_source": a["air_source"], "node_wbgt_f": round(r["node_wbgt_f"], 1),
            "forecast_wbgt_f": round(r["forecast_wbgt_f"], 1),
            "field_minus_forecast_f": round(r["node_wbgt_f"] - r["forecast_wbgt_f"], 1),
            "fhsaa_zone": fhsaa.zone(r["node_wbgt_f"]), "solar_inferred_w_m2": round(r["solar_w_m2"]),
            "globe_calibrated": False, "mode": mode}


def node_payload(row: dict[str, Any]) -> dict[str, Any]:
    """CONTRACTS.md node reading, plus additive fields saying where air/RH came from."""
    return {"node_id": "node-1", "ts": row["ts"], "air_temp_c": row["air_c"], "rh_pct": row["rh_pct"],
            "globe_temp_c": row["globe_c"], "tub_temp_c": None, "wind_m_s": None, "battery_v": None,
            "air_source": row["air_source"], "globe_calibrated": False}


# ── main loop ────────────────────────────────────────────────────────────────

def serial_lines(port: str, baud: int = 115200) -> Iterator[str]:
    import serial

    with serial.Serial(port, baud, timeout=5) as s:
        while True:
            yield s.readline().decode("utf-8", errors="replace")


def run(lines: Iterable[str], mode: str, post_url: Optional[str] = None, out_dir: Path = DATA_DIR,
        offline: bool = False, clock=None, use_a1: bool = False) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    now = (clock or (lambda: datetime.now().astimezone()))
    forecast = weather.get_forecast(SITE["lat"], SITE["lon"], offline=offline)
    air = AirSource(forecast, offline=offline, use_a1=use_a1)
    day = now().date().isoformat()
    path = out_dir / f"node_{day}.csv"
    raw_path = out_dir / f"node_{day}.raw.txt"
    new = not path.exists()
    warned = False
    with path.open("a", newline="") as f, raw_path.open("a") as raw_f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        for line in lines:
            if mode == "live":
                raw_f.write(line if line.endswith("\n") else line + "\n")   # keep the untouched serial stream
                raw_f.flush()
            raw = parse_line(line)
            if raw is None:
                continue
            row = make_row(raw, now(), air, mode)
            if row is None:
                continue
            w.writerow(row)
            f.flush()
            print(f"{row['ts'][11:19]}  globe {row['globe_c']:5.1f}°C  air {row['air_c']:4.1f}°C RH {row['rh_pct']:3.0f}% "
                  f"({row['air_source']})  →  field WBGT {row['node_wbgt_f']:5.1f}°F zone {row['fhsaa_zone']}  "
                  f"vs forecast {row['forecast_wbgt_f']:5.1f}°F  [{row['field_minus_forecast_f']:+.1f}]  uncalibrated", flush=True)
            if post_url:
                try:
                    import requests

                    requests.post(post_url, json=node_payload(row), timeout=3).raise_for_status()
                except Exception as e:  # noqa: BLE001 — logging continues without the engine
                    if not warned:
                        print(f"  (POST {post_url} failed: {e}; still logging to {path.name})", file=sys.stderr)
                        warned = True
    return path


def main(argv: Optional[list[str]] = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--port", help="serial port, e.g. /dev/ttyACM0")
    src.add_argument("--replay", type=Path, help="saved serial output to re-run (timestamps spaced 2 s from now)")
    ap.add_argument("--post", help="engine URL, e.g. http://localhost:8000/node")
    ap.add_argument("--out", type=Path, default=DATA_DIR)
    ap.add_argument("--offline", action="store_true", help="no network: cached forecast for air/RH")
    ap.add_argument("--use-a1", action="store_true", help="a shaded air thermistor is wired to A1 (ignored otherwise)")
    a = ap.parse_args(argv)
    if a.port:
        path = run(serial_lines(a.port), "live", a.post, a.out, a.offline, use_a1=a.use_a1)
    else:
        t0 = datetime.now().astimezone()
        ticks = iter(t0 + timedelta(seconds=2 * i) for i in range(10**9))
        path = run(a.replay.read_text().splitlines(), "replay", a.post, a.out, a.offline, clock=lambda: next(ticks), use_a1=a.use_a1)
    print(f"logged to {path}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
