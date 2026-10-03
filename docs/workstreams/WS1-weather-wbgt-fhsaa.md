# WS1 — Weather → WBGT → FHSAA zones   (owner: B · model: opus for wbgt.py, sonnet for the rest)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md and engine/constants.yaml. You own `engine/weather.py`, `engine/wbgt.py`, `engine/fhsaa.py` and their tests. Build in this order, committing after each:

1. **weather.py** — `get_forecast(lat, lon) -> list[WeatherHour]` from api.weather.gov (`/points/{lat},{lon}` → `forecastHourly` and the gridpoint raw data for dewpoint/RH, wind, sky cover). Send a User-Agent header. Convert units. Cache every response to `fixtures/forecast_<date>.json`; if the network fails, load the newest fixture and set `source="fixture"`.
2. **wbgt.py** — `wbgt_f(air_c, rh, wind, solar_w_m2, lat, lon, time) -> float` using the Liljegren model. Prefer PyWBGT; if it won't install, implement Liljegren yourself (natural wet-bulb + globe temperature iterations + solar position) and explain each equation in comments. Also `solar_from_cloud(lat, lon, time, cloud_pct)`: clear-sky irradiance from solar zenith × cloud attenuation, with the formula sourced in constants.yaml.
   - `wbgt_from_node(air_c, rh, globe_c, wind)` for the ESP32 node (outdoor WBGT = 0.7 Tnwb + 0.2 Tg + 0.1 Ta; derive Tnwb from air/RH/wind/radiation). Note the 40 mm globe caveat in a docstring.
3. **fhsaa.py** — read zones from constants.yaml. `zone(wbgt_f)`, `required_breaks(plan, weather)`, `violations(plan, weather) -> list[...]` for: max duration per zone, breaks/hour (count minutes of `is_break and shade` in each clock hour), gear restrictions, zone 5 = no outdoor activity, cooling-zone requirement above 82.1 °F.
4. **assimilate_env(forecast, node_readings)** — bias-correct the remaining forecast hours from field readings (start simple: rolling mean of node−forecast WBGT, decayed over 3 h; label hours `source="assimilated"`).
5. Tests: zone boundaries (82.0 vs 82.1), break counting across hour boundaries, a hand-checked WBGT case from a published Liljegren example, and fixture fallback.

Deliver a short note listing every formula you used and its source, and add them to constants.yaml.
