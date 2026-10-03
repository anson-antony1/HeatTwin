# CLAUDE.md — HeatTwin

You are working on **HeatTwin**, a 24-hour DTE Designathon (Software track) project. Read `PLAN.md` for the product and timeline and `CONTRACTS.md` for the data shapes. Your own task is in `docs/workstreams/WS*.md`, and the human will tell you which one.

## What HeatTwin is
A per-athlete heat-strain simulation for high school sports. Forecast → on-field WBGT → FHSAA zones; a transient two-node thermoregulation model predicts each athlete's core temperature through a practice plan; an optimizer rewrites the plan to stay under the safety line; live heart rate recalibrates the model; Collapse mode guides cold-water immersion.

## Non-negotiable rules
1. **Code to `CONTRACTS.md`.** Don't change a shape without telling the human. Other teammates' Claude sessions depend on it. If a shape must change, add a field and keep the old one working.
2. **No invented numbers.** Every physiological, regulatory or physical constant lives in `engine/constants.yaml` with `source`, `quote_or_location`, and `status: VERIFIED | TODO`. Never hard-code a constant in logic. If you don't have a source, add it with `status: TODO` and tell the human.
3. **No fabricated validation.** `validation/results.json` contains only numbers computed by code in `validation/` from real inputs. Synthetic or replayed data is labelled `synthetic: true` / `replay: true` everywhere it appears, including the UI.
4. **Safety language boundary.** HeatTwin never diagnoses, never says an athlete is "safe/fine/OK", never decides when to stop cooling, never recommends medication. Estimated core temperature is labelled "estimate — planning only." All user-facing generated text passes `engine/guard.py`. Rectal temperature is the only basis for treatment decisions (KSI/MHSAA).
5. **Patent flag.** `engine/ect_optional.py` (HR→core-temp Kalman, Buller et al.) is optional, off by default, and labelled "research mode — method appears patented." Core predictions come from the public two-node physics model.
6. **Fixtures first.** Every module must run against `fixtures/` with no network and no other teammate's code. Use cached forecast fixtures when NWS is unreachable, and label them.
7. **Tests.** Each module gets pytest/vitest tests. Physics tests check conservation/sanity: core temp rises with met rate, falls at rest in shade, monotonic in WBGT, and stays between 36 and 42 °C across fixtures.
8. **Small commits** on your workstream branch: `ws<N>: <what>`.

## Stack
- Engine: Python 3.11, numpy, FastAPI, pydantic v2, pythermalcomfort (JOS-3 reference), PyWBGT or own Liljegren, pytest.
- Web: React + Vite + TypeScript, Web Bluetooth (Heart Rate Service 0x180D), no UI kit heavier than needed; charts with a lightweight lib.
- Firmware: ESP32 Arduino (PlatformIO or Arduino IDE), SHT31/BME280 + DS18B20 ×2, JSON over HTTP POST (WiFi) with BLE or serial fallback.
- Optional runtime AI: Claude API for plan parsing (schema-validated), ElevenLabs pre-generated audio for Collapse mode.

## Commands
- `make dev` — engine on :8000 + web on :5173
- `make test` — all tests
- `make check-sources` — fails if any constant used in code is missing from constants.yaml or is TODO in a code path the demo uses

## Model routing for sub-agents (Claude Code)
- Physiology, calibration, optimizer, validation math → strongest model (`opus`), and ask it to show equations before code.
- UI scaffolding, styling, docs formatting → faster model (`sonnet`).
- Bulk mechanical edits / renames / test boilerplate → `haiku`.
- `.claude/agents/` defines `source-checker`, `physio-reviewer`, `demo-qa`. Run `physio-reviewer` after any change to `engine/physio/`.

## Definition of done for any task
Runs on fixtures · tests pass · no new untracked constants · user-facing text passes guard · you told the human what changed and anything you couldn't verify.
