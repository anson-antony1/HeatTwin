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
    python -m engine.node_bridge --port /dev/ttyACM0 --post http://localhost:8010/node
    python -m engine.node_bridge --replay data/node_2026-10-03.raw.txt     # re-run saved serial output
    python -m engine.node_bridge --port /dev/ttyACM0 --demo --post http://localhost:8010/node   # indoor demo
    python -m engine.node_bridge --port /dev/ttyACM0 --field --post http://localhost:8010/node  # air temp + NWS

``--field`` (the engine's default when it runs the bridge itself): the box's one thermistor is read as the field AIR
temperature, and NWS supplies humidity, wind and sunlight (engine/field_sensor.py); rows go to data/node_field_<date>.csv.
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

from engine import field_sensor, weather

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


class DemoScenario:
    """Indoor demo (constants.demo_node): the globe's rise above the room baseline is the only "sun".

    air_mode "station" (default): air temperature, RH and 10 m wind are the live NWS station observation (KGNV), so the
    only stand-in is the sun; "scenario": the fixed hot-day values in constants.demo_node (WBGT baseline_wbgt_f with
    no sun). Falls back to "scenario" when the station can't be reached. Labelled synthetic/DEMO either way.
    """

    def __init__(self, air: Optional[AirSource] = None, air_mode: Optional[str] = None, gain: Optional[float] = None):
        from engine import consts

        self.cfg = consts.get("demo_node")
        self.air_src = air
        self.air_mode = air_mode or self.cfg.get("air_mode_default", "scenario")
        self.gain = float(self.cfg.get("sun_gain", 1.0)) if gain is None else float(gain)
        self.baseline: list[float] = []
        self._set_scenario()
        if self.air_mode == "station":
            self.refresh_air()

    def _set_scenario(self) -> None:
        self.wind_10m = float(self.cfg["wind_10m_m_s"])
        self.wind_2m = self._wind_2m(self.wind_10m)
        self.rh = float(self.cfg["rh_pct"])
        self.air_c = self._solve_air()
        self.air_source = "demo_scenario"

    def refresh_air(self) -> None:
        """Pull the latest station observation (cached 10 min inside AirSource); keep the previous values if none."""
        if self.air_mode != "station" or self.air_src is None:
            return
        obs = self.air_src._station_obs()
        if obs is None:
            return
        self.air_c, self.rh = float(obs["air_c"]), float(obs["rh_pct"])
        self.wind_10m = float(obs["wind_m_s"]) if obs.get("wind_m_s") is not None else float(self.cfg["wind_10m_m_s"])
        self.wind_2m = self._wind_2m(self.wind_10m)
        self.air_source = f"nws_station_{self.air_src.station}"

    @staticmethod
    def _wind_2m(v10: float) -> float:
        from engine import consts, wbgt

        inp = consts.get("wbgt_inputs")
        stab = wbgt.stability_class(True, v10, 0.0, inp["night_dt_c"])
        return float(wbgt.wind_at_2m(v10, inp["wind_height_m"], stab, inp["urban"]))

    def _solve_air(self) -> float:
        """Air temperature at which WBGT (globe = air, no sun) equals baseline_wbgt_f — bisection."""
        from engine import wbgt

        lo, hi = 15.0, 45.0
        for _ in range(40):
            mid = 0.5 * (lo + hi)
            if wbgt.wbgt_from_node(mid, self.rh, mid, self.wind_2m) < self.cfg["baseline_wbgt_f"]:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)

    def baseline_wbgt_f(self) -> float:
        from engine import wbgt

        return float(wbgt.wbgt_from_node(self.air_c, self.rh, self.air_c, self.wind_2m))

    @property
    def ready(self) -> bool:
        return len(self.baseline) >= self.cfg["baseline_samples"]

    def row(self, raw: dict[str, float], t: datetime) -> Optional[dict[str, Any]]:
        from engine import fhsaa, wbgt

        if not self.ready:
            self.baseline.append(raw["globe_c"])
            print(f"  zeroing globe on the room: {raw['globe_c']:.2f}°C ({len(self.baseline)}/{self.cfg['baseline_samples']})",
                  flush=True)
            return None
        self.refresh_air()
        base = sum(self.baseline) / len(self.baseline)
        measured_rise = max(0.0, raw["globe_c"] - base)
        rise = measured_rise * self.gain
        globe = self.air_c + rise
        n = wbgt.node_components(self.air_c, self.rh, globe, self.wind_2m)
        b = self.baseline_wbgt_f()
        return {"ts": t.isoformat(timespec="seconds"), "globe_c": round(globe, 2), "globe_ohm": round(raw["globe_ohm"]),
                "air_c": round(self.air_c, 2), "rh_pct": round(self.rh, 1), "wind_m_s": round(self.wind_2m, 2),
                "air_source": self.air_source, "node_wbgt_f": round(n["wbgt_f"], 1),
                "forecast_wbgt_f": round(b, 1),
                "field_minus_forecast_f": round(n["wbgt_f"] - b, 1),
                "fhsaa_zone": fhsaa.zone(n["wbgt_f"]), "solar_inferred_w_m2": round(n["solar_inferred_w_m2"]),
                "globe_calibrated": False, "mode": "demo",
                "_demo": {"globe_measured_c": raw["globe_c"], "globe_baseline_c": round(base, 2),
                          "globe_rise_c": round(measured_rise, 2), "sun_gain": self.gain,
                          "wind_10m_m_s": round(self.wind_10m, 2)}}


class FieldFusion:
    """Field mode (engine/field_sensor.py): the one thermistor (A0) is the AIR temperature at the field; relative humidity,
    10 m wind and sunlight are NWS's (or the time-shifted pinned forecast when NWS is unreachable). WBGT = engine/wbgt.py."""

    def __init__(self, use_nws: bool = True):
        self.use_nws = use_nws

    def row(self, raw: dict[str, float], t: datetime) -> Optional[dict[str, Any]]:
        air = raw["globe_c"]                      # the sketch's A0 column; in field mode it is the air thermistor
        if not field_sensor.plausible(air):
            return None
        f = field_sensor.fuse(air, t, SITE["lat"], SITE["lon"], use_nws=self.use_nws)
        return {"ts": t.isoformat(timespec="seconds"), "globe_c": "", "globe_ohm": round(raw["globe_ohm"]),
                "air_c": f["air_temp_c"], "rh_pct": f["rh_pct"], "wind_m_s": f["wind_m_s"],
                "air_source": f"arduino_a0 + {f['weather_from']}", "node_wbgt_f": f["wbgt_f"],
                "forecast_wbgt_f": f["forecast_wbgt_f"],
                "field_minus_forecast_f": round(f["wbgt_f"] - f["forecast_wbgt_f"], 1), "fhsaa_zone": f["fhsaa_zone"],
                "solar_inferred_w_m2": "", "globe_calibrated": False, "mode": "field", "_field": f}


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
    if row.get("mode") == "field":       # only what the box measured; the engine adds NWS humidity / wind / sunlight
        return {"node_id": "node-1", "ts": row["ts"], "air_temp_c": row["air_c"], "tub_temp_c": None, "battery_v": None,
                "mode": "field", "air_source": "arduino_a0", "globe_calibrated": False}
    return {"node_id": "node-1", "ts": row["ts"], "air_temp_c": row["air_c"], "rh_pct": row["rh_pct"],
            "globe_temp_c": row["globe_c"], "tub_temp_c": None, "wind_m_s": None, "battery_v": None,
            "air_source": row["air_source"], "globe_calibrated": False,
            **({"demo": True, "synthetic": True, "wind_m_s": row["wind_m_s"], **row["_demo"]} if row.get("_demo") else {})}


# ── main loop ────────────────────────────────────────────────────────────────

class SerialNode:
    """The Uno over USB: read sketch lines, and send the engine's FHSAA zone back for the LEDs ("Z<n>\\n")."""

    def __init__(self, port: str, baud: int = 115200, timeout: float = 5):
        import serial

        self.port = port
        self.s = serial.Serial(port, baud, timeout=timeout)

    def present(self) -> bool:
        """The port is still listed by the OS (a vanished USB device drops out of the list)."""
        from serial.tools import list_ports

        return any(p.device == self.port for p in list_ports.comports())

    def lines(self, stop=None, silent_after_s: Optional[float] = None) -> Iterator[str]:
        """Sketch lines as they arrive. A read that times out yields "" (a tick, so the caller can check ``stop``) after
        checking the board is still there: raises SerialException when the port vanished, or when no line has come for
        ``silent_after_s`` (a hung board, or a port that lost its device) — the caller closes and rescans."""
        import serial

        last = time.monotonic()
        while stop is None or not stop.is_set():
            raw = self.s.readline()
            if raw:
                last = time.monotonic()
                yield raw.decode("utf-8", errors="replace")
                continue
            if not self.present():
                raise serial.SerialException(f"{self.port} is no longer connected")
            if silent_after_s is not None and time.monotonic() - last > silent_after_s:
                raise serial.SerialException(f"no data on {self.port} for {silent_after_s:g} s")
            yield ""

    def send_zone(self, zone: int) -> None:
        try:
            self.s.write(f"Z{int(zone)}\n".encode())
        except Exception:  # noqa: BLE001 — LEDs are a nice-to-have; never stop logging for them
            pass

    def close(self) -> None:
        try:
            self.s.close()
        except Exception:  # noqa: BLE001
            pass


def serial_lines(port: str, baud: int = 115200) -> Iterator[str]:
    return SerialNode(port, baud).lines()


def _console_line(row: dict[str, Any], demo: bool) -> str:
    if row.get("mode") == "field":
        fd = row["_field"]
        return (f"{row['ts'][11:19]}  air {row['air_c']:4.1f}°C (Arduino)  RH {row['rh_pct']:3.0f}% wind {row['wind_m_s']:3.1f} m/s "
                f"sun {fd['solar_w_m2']:4.0f} W/m² ({fd['weather_from']})  →  field WBGT {row['node_wbgt_f']:5.1f}°F "
                f"zone {row['fhsaa_zone']}  vs forecast {row['forecast_wbgt_f']:5.1f}°F  [{row['field_minus_forecast_f']:+.1f}]  "
                f"{field_sensor.label_for(fd['weather_from'])}")
    return (f"{row['ts'][11:19]}  globe {row['globe_c']:5.1f}°C  air {row['air_c']:4.1f}°C RH {row['rh_pct']:3.0f}% "
            f"({row['air_source']})  →  field WBGT {row['node_wbgt_f']:5.1f}°F zone {row['fhsaa_zone']}  "
            f"vs {'baseline' if demo else 'forecast'} {row['forecast_wbgt_f']:5.1f}°F  [{row['field_minus_forecast_f']:+.1f}]  "
            f"{'DEMO scenario' if demo else 'uncalibrated'}")


def run(lines: Iterable[str], mode: str, post_url: Optional[str] = None, out_dir: Optional[Path] = None,
        offline: bool = False, clock=None, use_a1: bool = False, demo: bool = False,
        air_mode: Optional[str] = None, send_zone=None, post_fn=None, stop=None, gain: Optional[float] = None,
        field: bool = False) -> Path:
    """post_fn(payload) -> response dict: post in-process (engine/node_autostart.py) instead of HTTP to post_url.
    stop: a threading.Event that ends the loop. field: field mode (FieldFusion; no forecast fetch, no cache files).
    out_dir defaults to data/ (looked up at call time)."""
    out_dir = DATA_DIR if out_dir is None else out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    now = (clock or (lambda: datetime.now().astimezone()))
    forecast = [] if field else weather.get_forecast(SITE["lat"], SITE["lon"], offline=offline)
    air = AirSource(forecast, offline=offline, use_a1=use_a1)
    fusion = FieldFusion(use_nws=not offline) if field else None
    scenario = DemoScenario(air, air_mode, gain) if demo else None
    if scenario:
        print(f"DEMO: air {scenario.air_c:.1f}°C, RH {scenario.rh:.0f}% ({scenario.air_source}); no-sun WBGT "
              f"{scenario.baseline_wbgt_f():.1f}°F. Heat the globe to add 'sun'.", flush=True)
    day = now().date().isoformat()
    path = out_dir / (f"node_demo_{day}.csv" if demo else f"node_field_{day}.csv" if field else f"node_{day}.csv")
    raw_path = out_dir / f"node_{day}.raw.txt"
    new = not path.exists()
    warned = False
    with path.open("a", newline="") as f, raw_path.open("a") as raw_f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        for line in lines:
            if stop is not None and stop.is_set():
                break
            if not line:                       # SerialNode.lines() tick: the read timed out
                continue
            if mode == "live":
                raw_f.write(line if line.endswith("\n") else line + "\n")   # keep the untouched serial stream
                raw_f.flush()
            raw = parse_line(line)
            if raw is None:
                continue
            row = (scenario.row(raw, now()) if scenario else fusion.row(raw, now()) if fusion
                   else make_row(raw, now(), air, mode))
            if row is None:
                continue
            w.writerow({k: v for k, v in row.items() if k in FIELDS})
            f.flush()
            print(_console_line(row, scenario is not None), flush=True)
            zone = row["fhsaa_zone"]
            if post_fn is not None:
                try:
                    body = post_fn(node_payload(row))
                    zone = (body.get("field") or body.get("hour") or {}).get("fhsaa_zone", zone)
                except Exception as e:  # noqa: BLE001
                    if not warned:
                        print(f"  (posting to the engine failed: {e})", file=sys.stderr)
                        warned = True
            elif post_url:
                try:
                    import requests

                    resp = requests.post(post_url, json=node_payload(row), timeout=3)
                    resp.raise_for_status()
                    body = resp.json()
                    zone = (body.get("field") or body.get("hour") or {}).get("fhsaa_zone", zone)   # the engine's zone
                except Exception as e:  # noqa: BLE001 — logging continues without the engine
                    if not warned:
                        print(f"  (POST {post_url} failed: {e}; still logging to {path.name})", file=sys.stderr)
                        warned = True
            if send_zone is not None:
                send_zone(zone)
    return path


def main(argv: Optional[list[str]] = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--port", help="serial port, e.g. /dev/ttyACM0")
    src.add_argument("--replay", type=Path, help="saved serial output to re-run (timestamps spaced 2 s from now)")
    ap.add_argument("--post", help="engine URL, e.g. http://localhost:8010/node")
    ap.add_argument("--out", type=Path, default=DATA_DIR)
    ap.add_argument("--offline", action="store_true", help="no network: cached forecast for air/RH")
    ap.add_argument("--use-a1", action="store_true", help="a shaded air thermistor is wired to A1 (ignored otherwise)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--demo", action="store_true",
                      help="indoor demo: zero the globe on the room; the globe's rise is the sun (constants.demo_node)")
    mode.add_argument("--field", action="store_true",
                      help="field mode: the thermistor is the air temperature; NWS humidity, wind and sunlight "
                           "(engine/field_sensor.py)")
    ap.add_argument("--demo-air", choices=["station", "scenario"], default=None,
                    help="demo air/RH/wind: live NWS station (default) or the fixed hot-day scenario")
    ap.add_argument("--no-leds", action="store_true", help="don't send FHSAA zones back to the Uno's LEDs")
    a = ap.parse_args(argv)
    if a.port:
        import serial

        node = SerialNode(a.port)
        try:
            path = run(node.lines(), "live", a.post, a.out, a.offline, use_a1=a.use_a1, demo=a.demo, air_mode=a.demo_air,
                       send_zone=None if a.no_leds else node.send_zone, field=a.field)
        except serial.SerialException as e:         # unplugged: the engine's built-in bridge (node_autostart) rescans; this one stops
            raise SystemExit(f"serial port lost: {e}") from e
    else:
        t0 = datetime.now().astimezone()
        ticks = iter(t0 + timedelta(seconds=2 * i) for i in range(10**9))
        path = run(a.replay.read_text().splitlines(), "replay", a.post, a.out, a.offline, clock=lambda: next(ticks), use_a1=a.use_a1,
                   demo=a.demo, air_mode=a.demo_air, field=a.field)
    print(f"logged to {path}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
