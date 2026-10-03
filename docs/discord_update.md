Engine update (ws2-physio, pushed): calibrated on Armstrong 2010 (whole-protocol rise; ACSM walking MET kept the ventilation credit) + checked against pill core temps from 5 football-practice studies: our medians run 0.6–0.8 °C above field peaks at matched WBGT, driven by drill intensity (reported, not tuned).
Demo fixture (?demo=1): all 16 athletes cross 39.0 °C at p95 by min 47–57; FHSAA break minutes short in both hours.
Optimize presets: fewest_changes = 5 changes, 81% load kept, +5 min; max_load = 13 changes, 83% kept, +20 min — both 0 FHSAA/NATA violations, max p95 38.99 °C. Warm both once before demoing (cached after: ~2 ms).
API: POST /optimize?demo=1&preset=fewest_changes|max_load; GET /settings (AT-owned limit/defaults); POST /hr + /live/start; POST /guard. CONTRACTS v1.1, additive only.
Next: engine/hr_bridge.py for the Amazfit Helio Strap (Zepp "Heart Rate Push") → POST /hr, records fixtures/hr_<date>.csv.
