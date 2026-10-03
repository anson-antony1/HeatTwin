# WS6 — Sideline node firmware   (owner: D · model: sonnet)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md. You own `firmware/`. Hardware: ESP32 dev board; SHT31 or BME280 (I2C: SDA 21, SCL 22) or DHT22 fallback; two DS18B20 probes on one 1-Wire bus (GPIO 4, 4.7 kΩ pull-up to 3.3 V) — probe A inside a matte-black 40 mm ping-pong ball (globe), probe B in the tub.

1. Read sensors every 10 s; average to 1 reading/min; identify DS18B20s by ROM address (print them at boot so we can label globe vs tub).
2. Send the JSON from CONTRACTS.md: HTTP POST to `http://<laptop-ip>:8000/node` over WiFi (credentials in `secrets.h`, gitignored). Fallbacks: BLE notify characteristic, or USB serial lines that `engine/node_bridge.py` forwards.
3. Also log to serial as CSV so we keep data if WiFi dies.
4. Globe build notes in `firmware/BUILD.md`: drill a hole, probe tip at the center, seal with hot glue, paint matte black, mount at the standard height (constants.yaml TODO) in full sun, keep the air sensor shaded and ventilated (a white cup with holes as a radiation shield).
5. Calibration check: all probes in an ice-water bath (≈0 °C) and room air against the kitchen thermometer; record offsets in `firmware/calibration.json`.
6. **Start logging outside by 4 PM Saturday** so the field-vs-forecast comparison has daylight hours.
