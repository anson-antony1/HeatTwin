# Sensor → web app demo (local branch sensor-live)

Heat the black-globe thermistor → the engine reads it as sunlight → field WBGT, FHSAA zone and every athlete's
estimate change in the web app within ~2 s, and the Uno's LEDs show the engine's zone.

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
