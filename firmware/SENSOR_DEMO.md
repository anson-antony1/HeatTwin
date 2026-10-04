# Arduino sensor → web app (field mode, and the indoor demo)

The box has one temperature sensor (a 10 kΩ NTC thermistor on A0). The engine runs the bridge itself
(`engine/node_autostart.py`) and has two modes, chosen by `HEATTWIN_NODE_MODE`:

| mode | what the thermistor is | everything else | label |
|---|---|---|---|
| **field** (default) | the field **air** temperature | humidity, wind and sunlight from live NWS | "Field sensor (Arduino) + NWS" |
| **demo** (`HEATTWIN_NODE_MODE=demo`, what `make sensor-demo` sets) | a black globe: its rise above the room is the "sun" | NWS station air/RH/wind (or a fixed hot day) | "DEMO scenario … (synthetic)" |

## Field mode (default)
```bash
make dev                  # engine + web; plug the Arduino in before or after, no restart ever needed
curl localhost:8010/node/status   # state, port, mode, and "source": which weather is active + last-reading age
```
- **Hot-plug.** Every 2 s (`constants.field_node.scan_every_s`) the engine lists USB serial ports and takes the Arduino:
  Arduino vendor ids first, then the common USB-serial chips (CH340/CH341, FTDI, CP210x), then device names
  `/dev/cu.usbmodem*`, `/dev/cu.usbserial*`, `/dev/ttyACM*`, `/dev/ttyUSB*`. Unplug it: the fallback below applies at
  once. Plug it back in, on the same port or a new name (macOS renumbers `usbmodem1101` → `usbmodem2301`): it is found
  on the next scan. A port another program holds (the Arduino IDE's Serial Monitor) shows `port_unavailable` and the
  next candidate is tried. A board that stays listed but sends nothing for `stale_after_s` is reopened.
- **What is measured and what is not.** The A0 reading is the air temperature. Humidity, 10 m wind and sunlight for the
  moment of the reading come from the NWS hourly forecast (interpolated, as the physiology model reads weather);
  WBGT is `engine/wbgt.py` (Liljegren) and the zone is `engine/fhsaa.py`. It is **not** a certified WBGT meter. The
  thermistor is uncalibrated (nominal Beta), and unshielded in the sun it reads above the air temperature — put it in
  the shade (a white cup with holes). Readings outside −20…60 °C are dropped as a wiring fault.
- **Which weather is active** (`GET /node/latest` and `/node/status` → `source`, shown on the web's field card):

  | `source.id` | label | when |
  |---|---|---|
  | `field_sensor_nws` | Field sensor (Arduino) + NWS | a reading arrived in the last `stale_after_s` (10 s) and NWS answers |
  | `field_sensor_snapshot` | Field sensor (Arduino) + forecast snapshot (time-shifted) | same, but NWS is unreachable: humidity / wind / cloud come from the pinned forecast shifted so its plan start lands on now |
  | `nws` | live NWS forecast | no recent reading (unplugged, silent) — falls back automatically |
  | `snapshot` | forecast snapshot (time-shifted) | no recent reading and NWS unreachable |

  `source.reading_age_s` is how long ago the Arduino last spoke (it keeps counting after an unplug).
- **Where it is used.** A live HR session (`POST /live/start {"start_now": true}`) takes its weather from this chain, and a
  running one re-runs it when the board appears or goes away, when NWS arrives after a snapshot start, or when the air
  temperature moves ≥ 0.5 °C. `?demo=1` Plan / Optimize never use the sensor: they stay on the pinned forecast. The
  web's field card chip reads, e.g., "Field sensor + NWS · 4 s ago" (hover for the full explanation); with a plain plan
  on screen it keeps today's chip and the hover text says the sensor is connected.
- **NWS fetch.** Cached in memory for 10 min and refreshed in a background thread (a slow network never stalls the
  serial reader); a failed fetch is retried after 30 s. Nothing is written to `fixtures/weather_cache/`.
- **Logs.** `data/node_field_<date>.csv` (mode `field`; never read as a globe recording by validation) and the raw serial
  stream `data/node_<date>.raw.txt`.
- **Standalone bridge** (instead of the engine's built-in one): `python -m engine.node_bridge --port /dev/cu.usbmodem1101 --field --post http://localhost:8010/node`.
- **Serial format** is unchanged (`ms,globe_adc,globe_ohm,globe_c,air_adc,air_ohm,air_c` every 1–2 s, `Z<n>` back for the
  LEDs): in field mode the `globe_c` column is the air thermistor and A1 is ignored. The LEDs show the zone of the field
  WBGT.

## Indoor demo (globe as sun) — `HEATTWIN_NODE_MODE=demo`
Heat the black-globe thermistor → the engine reads it as sunlight → field WBGT, FHSAA zone and every athlete's
estimate change in the web app within ~2 s, and the Uno's LEDs show the engine's zone. `make sensor-demo` /
`./scripts/demo_sensor.sh` set this mode.

**Air temperature, humidity and wind are real** (live NWS KGNV airport observation; `--demo-air scenario` uses the
fixed hot day in constants.demo_node instead). **The sun is the stand-in**: the thermistor's rise above the room
reading. Everything is labelled "DEMO scenario … (synthetic) — not field data".

## Wiring (Uno R3)
- 5V ── thermistor ── A0 ── 10 kΩ ── GND
- D11 → 220 Ω → green LED → GND · D10 → yellow · D9 → red (long LED leg toward the pin)

## Run (one command, repo root)
```bash
make sensor-demo          # or ./scripts/demo_sensor.sh — engine + built-in Arduino bridge + web, opens the browser
```
Plug the Uno in before or after; the engine finds it (Arduino USB id) and zeroes on the room — hands off the thermistor
for ~5 s. Unplug it and the app returns to the forecast within ~2 s. Ctrl+C stops everything.
`curl localhost:8010/node/status` → waiting / connected / port_unavailable (e.g. the Arduino IDE's Serial Monitor has
the port — close it). `HEATTWIN_NODE=off` disables the built-in bridge.

Defaults (constants.demo_node): fixed hot-day scenario (80 °F with no sun) and `sun_gain: 3.0`, so a fingertip spans
the zones: pinch → red (zone 4) in ~2 s, a long firm pinch → zone 5. Labelled "demo sensitivity: … 3×".

## LEDs
green = zone 1 · yellow = zones 2–3 · red = zone 4 · red blinking = zone 5. With the bridge running they show the
engine's zone (same as the app). Without it (or >5 s without a zone) the Uno uses its own estimate on the fixed hot-day
scale and flicks off briefly once a second.

## How much heat it takes (rise of the thermistor above the room)
| air/RH source | no-sun WBGT | yellow | red | red blinking |
|---|---|---|---|---|
| KGNV at midnight (23 °C, 100 %) | 73.5 °F | +12.9 °C | +25.4 °C | +28.6 °C |
| KGNV ~11 AM typical (28 °C, 75 %) | 78.0 °F | +6.1 °C | +18.6 °C | +21.8 °C |
| `--demo-air scenario` (29.7 °C, 70 %) | 80.0 °F | +3.1 °C | +15.7 °C | +18.9 °C |

A hair dryer on high (~6 in away) reaches roughly +20–30 °C. Keep heat guns away (they can melt the tape/ball).

## Demo beat
Plan (red) → Optimize (green, pinned forecast, deterministic) → heat the ball → the optimized plan is re-simulated with
the sensor's sun and athletes climb back toward the line; LEDs step green → yellow → red.
