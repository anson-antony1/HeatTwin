# HeatTwin — DTE Designathon 2026 project plan (Software track)

> **One line:** HeatTwin simulates every athlete's core temperature through *today's* practice plan before practice starts, rewrites the plan so nobody crosses the line, then watches live and walks a coach through cold-water immersion if someone still goes down.

Event clock: hacking 12:00 PM Sat Oct 3 → **code freeze 11:00 AM Sun**, submit by 12:00 PM, demos 12:15–2:15 PM, winners 2:30 PM.
Submission: GitHub repo + Devpost with a 1–4 page write-up (target market, problem, technology, functionality).
Judged on: **Technical Complexity · Novelty · Potential for Impact · Feasibility/Manufacturability · Final Presentation.**

---

## 1. The reconciled idea (one product, three layers)

| Layer | What it does | Hardware? | Rubric it carries |
|---|---|---|---|
| **1. Plan** — *the core* | NWS forecast → hourly on-field WBGT (Liljegren) → FHSAA zone per hour. Coach enters drills. A **two-node thermoregulation model per athlete** (body size, gear, drill intensity, acclimatization day) predicts core temp minute by minute. A **constrained optimizer** reorders drills, inserts breaks, changes gear so every athlete's predicted p95 core temp stays below the AT-owned planning line while keeping as much training as possible, and never breaks FHSAA rules. | No | Complexity, Novelty |
| **2. Watch** | Live heart rate from straps/watches athletes already own (Web Bluetooth, standard Heart Rate Service) recalibrates each athlete's model during practice and re-forecasts the rest of the session. Personal baselines (Relay engine). Coordination + persistence gates so it doesn't cry wolf. | Optional sideline node | Complexity, Impact |
| **3. Respond** | One-tap **Collapse mode**: clock from collapse, voice-guided cool-first protocol (KSI), live tub water temp, EMS handoff timeline. | Optional tub probe | Impact, Presentation |

**Where hardware fits (and why it isn't decoration):** the forecast is for the *town*, not *your field*. A $30 sideline node measures the field's real WBGT, and the twin **assimilates it** to correct the forecast (bias-correct the remaining hours). That gives us a measured result for the write-up — "forecast vs. our field, N hours, bias X °F" — that no other team will have. The tub probe makes the Respond demo physical. Both are optional: the product runs with zero new hardware (Feasibility), and the node is the "manufacturable $30 add-on" (Manufacturability).

**Safety boundary (state it on a slide):** estimated core temp is for *planning and early warning only*. It never diagnoses, never says an athlete is fine, never decides when to stop cooling — rectal temperature is the only basis for treatment (KSI/MHSAA guidance). A language guard enforces this on every generated sentence (borrow Relay's).

**IP note (Khanna will ask):** the heart-rate → core-temperature Kalman method (Buller et al.) appears to be covered by a patent ("Method and System for Indirectly Determining Core Body Temperature Using Heart Rate", priority Dec 2012). So the **public two-node physics model is our core**; the HR→core-temp filter is an optional, clearly labelled module we would license for a product. What's ours: per-athlete calibration + the practice-plan optimizer + the field-WBGT assimilation.

---

## 2. Why this is hard to copy in 24 h (the "AI builds it fast" problem)

Code volume is cheap now. What isn't:
1. **A transient physiology model that has to be right** — two-node heat balance with changing activity, gear and weather every minute, vectorized across a 40-player roster, cross-checked against JOS-3.
2. **An optimizer with a simulation inside it** — hundreds of candidate plans × 40 athletes × 120 minutes, under hard FHSAA constraints.
3. **Data that only exists because we collected it tonight** — field WBGT vs forecast logs, teammates' HR during real exercise.
4. **A validation table with a source for every number** — reproduce a published football-uniform heat study and report our error honestly.
5. **Every constant sourced** in `engine/constants.yaml` with a citation and a status. Judges can ask "where does 39.0 come from?" and we answer in one click.

---

## 3. Architecture

```
heattwin/
├─ CLAUDE.md                 # Claude Code project memory (read first)
├─ PLAN.md                   # this file
├─ CONTRACTS.md              # frozen data shapes — every workstream codes to these
├─ SOURCES.md                # every number → citation
├─ engine/                   # Python 3.11, FastAPI
│  ├─ constants.yaml         # every physiological / regulatory constant, with source + status
│  ├─ weather.py             # NWS api.weather.gov hourly forecast → WeatherHour[]
│  ├─ wbgt.py                # Liljegren WBGT (PyWBGT or own impl) + solar position
│  ├─ fhsaa.py               # zone table, breaks/hour, max duration, gear rules
│  ├─ physio/
│  │  ├─ twonode.py          # OUR transient two-node model, numpy-vectorized over roster
│  │  ├─ jos3_ref.py         # JOS-3 reference runs (pythermalcomfort) for cross-checking
│  │  ├─ metabolic.py        # drill → MET; HR → %HRR → metabolic rate
│  │  └─ clothing.py         # gear level → clo / evaporative resistance
│  ├─ calibrate.py           # per-athlete parameter update from live HR (ensemble filter)
│  ├─ ect_optional.py        # HR→core temp Kalman (research mode, patent-flagged)
│  ├─ optimizer.py           # plan search under constraints (sim. annealing / beam search)
│  ├─ guard.py               # language guard (no diagnosis / no "safe" claims)
│  ├─ api.py                 # FastAPI routes (see CONTRACTS.md)
│  └─ tests/
├─ web/                      # React + Vite + TypeScript
│  ├─ Plan view              # drill timeline × athlete heat strip, red→green after Optimize
│  ├─ Live view              # roster cards, Web Bluetooth HR pairing, re-forecast
│  ├─ Collapse mode          # big clock, voice steps, tub temp, EMS handoff
│  └─ Sources page           # renders SOURCES.md + constants status
├─ firmware/                 # ESP32 (Arduino/PlatformIO)
│  └─ node.ino               # SHT31/BME280 + DS18B20 globe + DS18B20 tub → JSON over WiFi or BLE
├─ fixtures/                 # sample roster, plan, forecast, HR traces — lets every stream work alone
└─ validation/
   ├─ published_repro.ipynb  # reproduce published football-uniform heat study conditions
   ├─ field_vs_forecast.ipynb
   └─ results.json           # numbers the write-up quotes
```

**Runtime AI (not in the safety loop):**
- *Claude API (optional):* coach types the plan in plain English ("10 min warmup, 20 min individual, 15 min team period in full pads…") → `Drill[]` JSON. Output is validated against the schema; the coach confirms.
- *ElevenLabs:* Collapse-mode voice. **Pre-generate the audio clips** and ship them as files, so the demo works with no network.
- Nothing an LLM writes reaches the coach without passing `guard.py`.

---

## 4. Hardware — what, why, where

### Bill of materials (prices approximate — check before buying)

| Part | Use | Approx. |
|---|---|---|
| ESP32 dev board | Node MCU, WiFi/BLE | ~$8–12 |
| SHT31 / SHT45 (or BME280) | Air temp + RH | ~$5–12 |
| DS18B20 waterproof probe ×2 | Globe temp + tub temp | ~$3–5 each |
| 4.7 kΩ resistor, breadboard, jumpers | 1-Wire pull-up, wiring | DTE kit |
| Ping-pong ball (40 mm) + matte black spray paint | Mini black globe (probe tip at center, sealed with hot glue) | ~$5 |
| USB power bank | Field power | have one |
| PVC pipe / camera tripod | Mount ≈1.1 m (verify height for standing WBGT, ISO 7243) | ~$5 |
| Cooler or storage bin + ice | Stand-in tub for demo | ~$10 |
| Kitchen thermometer | Reference check for probes | ~$10 |
| HR straps (Polar / Coospo / Garmin "broadcast HR") | Live HR via Web Bluetooth | borrow |

Optional: cup anemometer (otherwise use forecast wind and say so).

**Caveat to say out loud:** a 40 mm globe isn't the standard 150 mm globe. Small globes respond faster and need a convection correction. We **compare it against the forecast-derived WBGT and report the difference**; we don't claim it's a certified WBGT meter.

### Where to get it (weekend reality)
1. **DTE parts table at Marston (organizer deck: "Electronic parts available at Marston Library") — go first, right now.** Ask for ESP32, SHT/BME/DHT sensor, DS18B20, resistor, breadboard, jumpers. If they only have a DHT22, use it (worse RH accuracy; note it).
2. **Marston Makerspace (basement) is closed on weekends** (open Mon–Fri 2–7 PM), so don't count on it, and Open Lab items can't leave the room anyway.
3. **Local retail (Archer Rd / Butler Plaza area):** Walmart/Target for ping-pong balls, matte black spray paint, a cooler, a kitchen thermometer, zip ties. Home Depot/Lowe's for PVC. Best Buy / Dick's for a chest strap if nobody can lend one.
4. **People:** post in the DTE Discord: "need ESP32 + DS18B20 + an HR strap." Triathlon/cycling club members and runners often have Polar/Garmin straps.
5. **Amazon:** check the app for same-day/overnight to Gainesville. Treat it as a backup that may arrive too late.

**Decision rule:** if no ESP32 + sensor by **4:00 PM**, drop the node, keep Tier 0 (forecast + HR), and move that person to validation. The node is only worth it if it logs **daylight** hours Saturday, so time matters.

### Web Bluetooth note
Chrome on desktop/Android can read the standard Heart Rate Service (0x180D) directly from a web page. **iOS Safari can't**, so demo on a laptop or Android. An Apple Watch doesn't broadcast the standard profile by default; Garmin watches have a "Broadcast Heart Rate" mode.

---

## 5. Team roles (4 people) and workstreams

| Person | Workstreams (see `docs/workstreams/`) | Owns |
|---|---|---|
| **A — Engine lead** | WS2 physiology, WS4 optimizer | `engine/physio`, `optimizer.py` |
| **B — Data & weather** | WS1 weather/WBGT/FHSAA, WS3 calibration, WS7 validation | `weather.py`, `wbgt.py`, `fhsaa.py`, `calibrate.py`, `validation/` |
| **C — App** | WS5 web app (Plan, Live, Collapse, Sources) | `web/` |
| **D — Hardware + story** | WS6 firmware + Web Bluetooth, parts run, write-up, slides, demo | `firmware/`, `docs/writeup.md`, deck |

Each person runs **their own Claude Code session in their own git worktree/branch** and codes only to `CONTRACTS.md`. Integration happens on `main` at the milestones below.

---

## 6. Timeline (Sat 12:45 PM → Sun 12:00 PM)

| Time | Milestone | Done means |
|---|---|---|
| **12:45–1:30** | **M0 Setup** | Repo created, kit committed, `CONTRACTS.md` frozen, fixtures in place, D on parts run, everyone's Claude Code session started from their workstream brief |
| 1:30–4:00 | Build block 1 | WS1 real forecast→WBGT→zones for Gainesville; WS2 two-node model runs one athlete through fixture plan; WS5 Plan view renders fixture `SimulationResult`; WS6 node prints readings |
| **4:00** | **Hardware go/no-go** | Node logging outside in sun, or dropped |
| 4:00–6:00 | Build block 2 | Roster-vectorized sim; FastAPI `/simulate`; UI calls real API |
| **6:00–6:45** | Dinner + **M1 "Red plan"** | End to end: real forecast + fixture roster + plan → UI shows athletes going red. **This is the minimum demo.** Commit a tag. |
| 6:45–10:00 | Build block 3 | Optimizer v1 (breaks, reorder, gear); Web Bluetooth HR live; calibration v1; Collapse mode UI; JOS-3 cross-check |
| **10:00** | **M2 "Optimize turns it green"** | Optimize button produces a valid FHSAA-compliant plan; live HR updates a card |
| 10:00 PM–1:00 AM | Validation & data | Teammates do a real HR exercise session (stairs/burpees, log RPE); published-study reproduction; field-vs-forecast notebook from the afternoon log; `results.json` |
| 1:00–6:00 AM | Rotating sleep (2 awake) | Tests, language guard, Sources page, pre-generated voice clips, bug fixes |
| 6:00–9:00 | Polish | UI polish, write-up draft, deck, Devpost text |
| 9:00–10:30 | Rehearse ×3 | 3-min demo + 2-min Q&A drill (judge questions in §8) |
| **11:00** | **Code freeze** | Tag `v1.0`, record a backup demo video |
| 11:00–12:00 | Submit | Devpost + GitHub link + write-up PDF, checked by someone who didn't write it |

---

## 7. Demo script (3 minutes)

<!-- demo-numbers:start (generated by scripts/demo_numbers.py — do not edit by hand) -->
*Generated by `scripts/demo_numbers.py` from the engine (`?demo=1`: fixed seed, pinned saved forecast whose WBGT is
NWS's own layer; synthetic plan and roster). Numbers also in `docs/demo_numbers.md`. **Before presenting:** start the
engine without auto-reload (`make demo`) and run `make warm` (simulate, both optimize presets, the HR replay and the
comparison, with the exact bodies the web sends; the fewest-changes search is slow cold). Say "estimate — planning
only" once, and that the 39.0 °C line and the near band are illustrative defaults an athletic trainer would own.*

1. **(20 s) Hook** (facts and sources in SOURCES.md). "More than 70 high school athletes have died of exertional heat stroke since 1982. Cooled within 30 minutes, survival is essentially 100%. A third of exertional heat illness events happen with no athletic trainer present. Florida law already requires heat monitoring and an ice tub. Nobody tells a coach what *today's* practice will do to *each* kid."
2. **(40 s) Plan.**
   - **Forecast:** the Gainesville forecast is NWS's own WBGT grid, cached and labelled. Practice runs 15:30–17:23 at 86 / 83 / 82 °F WBGT, FHSAA zones 2 / 2 / 1.
   - **Plan:** load the 113-minute practice (or say it to Kelvin: Gemini drafts the drills, the coach confirms). Gear follows NATA phasing.
   - **Heat strip:** every athlete's p95 estimate crosses the 39.0 °C planning line between minute 46 and minute 52. First: Caleb and Isaiah (acclimatization day 2) at minute 46; then Jordan, Logan, Darius and Kai at minute 47.
   - **FHSAA:** the engine finds 2 issues: 3 PM hour: 0 separate shaded rest breaks of ≥4 min scheduled, 2 required for 30 min of practice; 4 PM hour: 2 separate shaded rest breaks of ≥4 min scheduled, 3 required for 60 min of practice.
3. **(30 s) Watch** — do this BEFORE Optimize (the HR replay was recorded on this plan; after Optimize, Undo first).
   - Live: a teammate wears the Amazfit Helio Strap and does burpees (`POST /live/start {"start_now": true, "live_demo": {"a07": "conditioning"}}`, then `python -m engine.hr_bridge --map a07=Helio`). Their HR is read against the plan's conditioning drill, labelled "live demo · conditioning". Weather is live NWS, or the pinned forecast shifted to now, labelled "forecast snapshot (time-shifted)". The recording lands in `fixtures/hr_<date>.csv` as calibration evidence; it does not replace the replay.
   - Otherwise the replay is `fixtures/hr_a07_synthetic.csv`, labelled "synthetic HR (not a real athlete)" (synthetic; the real Oct 3 Helio recording is calibration evidence on the Athlete twin, not a replay of this plan). met_scale moves to 1.2392 over 59 one-minute updates; the gate reads "re-forecast shows crossing".
   - Field node: until a node recording exists (`data/node_<date>.csv`), the field panel says "no field recording yet".
4. **(40 s) Optimize** (max-load preset, warmed).
   - **Engine's change list (12 changes):**
     - Moved 'Team period (platoon A)' to 15:44 (was 16:19)
     - Moved 'Individual period' to 17:15 (was 15:40)
     - Split 'Inside run' into 2 parts around shaded breaks (7 + 8 min)
     - 'Inside run': full pads → helmet + shoulder pads
     - Ran 'Inside run' with rotating groups (part 1: 4 athletes × 7 min, part 2: 8 athletes × 8 min); athletes not in a part rest in the shaded cooling area; sitting out the whole drill: Tyler (fictional), Caleb (fictional), Logan (fictional), Kai (fictional)
     - Ran 'Team period' in 2 platoons (8 athletes × 12 min, 8 athletes × 13 min); the resting platoon waits in the shaded cooling area
     - 'Team period': full pads → helmet only
     - 'Water break': full pads → helmet only
     - 'Conditioning (gassers)': helmet only → no pads
     - Added a 4-min shaded water break after 'Dynamic warmup' at 15:40
     - Added a 4-min shaded water break after 'Inside run (platoon B)' at 16:32
     - Added a 12-min shaded water break after 'Special teams' at 16:51
   - **Say:** "All 16 athletes are under 39.0 °C at p95 (max 38.98); 8 are in the near band. 0 FHSAA and NATA issues. 72.9% of the training load kept with 12 changes. Practice runs to 17:43, 20 minutes longer."
   - **Top 3 changes by heat reduction** (Kelvin reads the engine's `top_changes_text`):
     1. "Ran 'Team period' in 2 platoons (8 athletes × 12 min, 8 athletes × 13 min); the resting platoon waits in the shaded cooling area" — about 0.7 °C off the estimated team peak.
     2. "Moved 'Team period (platoon A)' to 15:44 (was 16:19)" — about 0.4 °C off the estimated team peak.
     3. "Ran 'Inside run' with rotating groups (part 1: 4 athletes × 7 min, part 2: 8 athletes × 8 min); athletes not in a part rest in the shaded cooling area; sitting out the whole drill: Tyler (fictional), Caleb (fictional), Logan (fictional), Kai (fictional)" — about 0.4 °C off the estimated team peak.
   - **Fewest changes (optional):** "Ask for 6 changes or fewer: it says no plan within 11 changes meets every rule with everyone under the line — it needs at least 12 — and shows that plan (72.9% of the load kept)."
   - **Inputs (optional):** the comparison panel shows the same plan with three weather inputs — Saved forecast (cached NWS, NWS WBGT) — pinned: zone 2, 72.9% kept, 12 changes; Live NWS forecast + NWS WBGT: zone 2, 73.7% kept, 20 changes; Live NWS forecast + our Liljegren WBGT: zone 3, 55.2% kept, 14 changes. Our Liljegren WBGT runs hotter than NWS's (see MODEL.md); the headline uses NWS's.
   - **Ask Kelvin (optional):** "Who crosses first?", "What if we drop the gassers?" — Gemini only picks the question type; the engine computes and writes the sentence, checked by the language guard and the per-answer number check before it is shown or spoken.
5. **(30 s) Respond.** Hit Collapse. The clock starts, the voice reads the KSI cold-water-immersion steps, and an EMS timeline is generated. The tub panel says "no probe connected" unless a node reports tub temperature. Every generated sentence passes `engine/guard.py`.
6. **(20 s) Close.** Validation, from `validation/results.json`, said plainly:
   - **Armstrong 2010 (lab):** calibrated on the full-uniform rise (conservative mode); whole-protocol rise RMSE 0.03 °C over 2 clothing conditions.
   - **Football practice pill data (field, held out):** published practice peaks: group-mean practice peaks 38.2–38.8 °C; individual maxima 39.1–39.3 °C; no reading ≥ 40 °C reported. Rerun at each study's own conditions (3 study groups), our median peak runs 0.85–2.31 °C above the measured group means (overcast to clear-sky); 3 further comparisons (the demo roster on the demo forecast vs study cohorts at a similar WBGT) run 1.4–1.73 °C above. Our drill intensities are game values; live HR from the team's own practices is how we calibrate that down, and until then the estimate errs hot.
   - Then the node cost vs per-athlete wearables (§4), the IP position, and the next step: pilot with one Gainesville high school, then UF I2E.
<!-- demo-numbers:end -->

---

## 8. Judge prep (likely questions)

- **"Is the core temp accurate?"** → Show the validation table, the uncertainty band (p95), and the boundary: planning only, never treatment.
- **"What's the IP?"** → Physics model is public; ours is per-athlete calibration + optimizer + field assimilation; the HR→core-temp filter is patented, so we'd license it.
- **"Who pays?"** → School districts / athletic programs, annual subscription per school. Florida law already requires the monitoring, and districts already buy WBGT services.
- **"Is it a medical device?"** → Positioned as heat-strain planning; no diagnosis; clinician/AT decides. Same boundary as Relay.
- **"Why not just use a WBGT meter?"** → A meter tells you the field. We tell you *each athlete* under *this plan*, and how to change the plan.
- **"What about kids without straps?"** → The model runs from roster data alone; HR only sharpens it.

---

## 9. Write-up outline (1–4 pages, matches the required topics)

1. **Problem** — EHS deaths, 100% survivable with fast cooling, the AT coverage gap, the Florida mandate.
2. **Target market** — FHSAA schools (then other Southern states with WBGT rules), club sports, marching band.
3. **Technology** — forecast→WBGT, two-node model, calibration, optimizer, field node, language guard; diagram.
4. **Functionality** — Plan / Watch / Respond with screenshots.
5. **Validation** — table from `validation/results.json`, with limitations stated plainly.
6. **Feasibility & manufacturability** — zero-hardware tier, $30 node BOM, deployment.
7. **Next steps** — HS pilot, AT-owned thresholds, licensing, I2E.

---

## 10. Risks and fallbacks

| Risk | Fallback |
|---|---|
| No parts | Tier 0: forecast + HR. Field node becomes "next step" with BOM in the write-up. |
| No HR straps | Phone app that broadcasts HR, or replay recorded traces from `fixtures/` (label it as replay). |
| Optimizer too slow | Coarser time step (2 min), fewer candidate moves, surrogate = two-node only. |
| JOS-3 disagrees with our model | Report the gap honestly in validation; that's a finding, not a failure. |
| NWS API down | Cached forecast in `fixtures/` (label it). |
| Venue WiFi blocks ESP32 | BLE from node to laptop, or USB serial. |
| Web Bluetooth flaky | Pair before the demo; keep replay mode ready. |
