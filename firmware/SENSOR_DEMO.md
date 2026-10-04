# Sensor → web app demo (local branch sensor-live)

Heat the black-globe thermistor → the engine reads it as sunlight → field WBGT, FHSAA zone and every athlete's
estimate change in the web app within ~2 s, and the Uno's LEDs show the engine's zone.

**Air temperature, humidity and wind are real** (live NWS KGNV airport observation; `--demo-air scenario` uses the
fixed hot day in constants.demo_node instead). **The sun is the stand-in**: the thermistor's rise above the room
reading. Everything is labelled "DEMO scenario … (synthetic) — not field data".

## Wiring (Uno R3)
- 5V ── thermistor ── A0 ── 10 kΩ ── GND
- D11 → 220 Ω → green LED → GND · D10 → yellow · D9 → red (long LED leg toward the pin)

## Run (three terminals, repo root)
```bash
# 0. once: flash the sketch (close the IDE's Serial Monitor first)
~/.local/bin/arduino-cli upload --fqbn arduino:avr:uno -p /dev/ttyACM0 firmware/node_leds
# 1. engine
env -u PYTHONPATH .venv/bin/python -m uvicorn engine.api:app --port 8010
# 2. web (needs Node ≥ 20; Node 22 is in ~/.local/node22)
cd web && PATH=$HOME/.local/node22/bin:$PATH npm run dev        # open http://localhost:5173
# 3. bridge (keep the ball at room temperature for the first 5 s while it zeroes)
env -u PYTHONPATH .venv/bin/python -m engine.node_bridge --port /dev/ttyACM0 --demo --post http://localhost:8010/node
```

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
