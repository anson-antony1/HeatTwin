# WS3 — Per-athlete calibration from live HR   (owner: B · model: opus)

**Paste into Claude Code:**
> Read CLAUDE.md, CONTRACTS.md. You own `engine/calibrate.py` and `engine/ect_optional.py`. Depends on WS2's `simulate_roster` signature (use a stub until it lands).

1. **calibrate.py** — ensemble Kalman (or particle) update of each athlete's `AthleteCalibration` from HR:
   - Observation model: the two-node sim predicts the HR a given met + thermal strain should produce (cardiovascular drift with rising core/skin temp — cite a relationship or keep it simple and say so). Observed HR updates `met_scale` (and weakly `thermo_scale`).
   - Gates borrowed from Relay: only flag "re-forecast shows crossing" when (a) p95 crosses the limit, (b) it persists ≥ N minutes, and (c) HR data coverage is adequate. Otherwise state "not enough data". Show which gate held it back.
   - Personal baseline: resting HR and HR-at-load per athlete from prior sessions (median/MAD, like Relay).
2. `POST /hr` handler logic: append the reading, update calib every 60 s, re-run the rest of the plan from now, return `reforecast`.
3. **ect_optional.py** — Buller HR→core-temp Kalman filter, off by default, coefficients from constants.yaml (status TODO until verified), header comment: "research mode — method appears patented; see SOURCES.md."
4. Replay mode: feed `fixtures/hr_*.csv` at 10× speed for demo/testing, with every output labelled `replay: true`.
5. Tests: calibration converges on synthetic data generated with a known met_scale; gates suppress single spikes.
