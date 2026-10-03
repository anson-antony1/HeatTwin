# HeatTwin audit: numbers, data flows, voice, contracts, branches (2026-10-03)

This is a read-only survey. No code was changed to produce it.

- **Rule being audited:** every number the app shows or speaks must come from the engine (ws2-physio, plus ws1 for weather/FHSAA) and the data we actually have. It must not come from stand-ins, hard-coded values or an LLM.
- **Branches surveyed:** after `git fetch --all --prune`, origin has `main` 0df1470, `webapp` b343a4b, `ws2-physio` 07e33d3, `ws1-weather` 1f980ab, `llm-bridge` b63ee4a and `voice-twin` e01b774.
- **Missing branches:** there is **no `voice-plan` branch on origin**, and no hardware branch.

**Verdict key** (used in §4):

| Verdict | Meaning |
|---|---|
| **ENGINE** | Comes from an engine endpoint (validated model, cited constants) |
| **OK-CONST** | A literal that matches a cited constant in `engine/constants.yaml` |
| **WRONG** | Contradicts a verified source or the engine |
| **UNSOURCED** | A literal with no citation |
| **STAND-IN** | Output of the in-browser placeholder model or optimizer |
| **SYNTHETIC** | Fake sensor data presented on screen as if it were real |

---

## 0. Headline findings

1. **The web app on `main` never calls the engine.**
   - There is no `fetch`, no `VITE_` variable and no `localhost:8000` anywhere in `web/src`.
   - Every heat number on Plan, Live roster, Athlete twin and Collapse comes from `web/src/data/model.ts`. Its own comment calls it "a single-node heat balance, tuned by eye — NOT the validated model".
   - It also uses `optimizer.ts` (greedy, labelled "Placeholder for engine/optimizer.py") and `engine.ts` (a fake live loop).
2. **The web FHSAA zone table is wrong**, compared with FHSAA Policy 41 §41.8.3 (verified in ws1 `constants.yaml` from the 2025-26 handbook, p.107).
   - The web uses cut-offs at 80, 85, 87.1 and 90.1 °F and 3-minute breaks. "Black" (no practice) starts at 90.1 °F, and the web has no "max 1 h" zone.
   - FHSAA's cut-offs are 82.1, 87.1, 90.1 and 92.1 °F, with 4-minute breaks and max 2 h and max 1 h zones.
   - The Plan screen still shows "✓ Meets FHSAA red zone rules".
3. **Live heart rate on Coach and Athlete is synthetic, and the loop is circular.**
   - A hidden "truth" (`TRUE_HEAT_FACTOR`) drives fake HR plus noise.
   - The estimate is then pulled toward that truth.
   - It is labelled "Calibrated from live HR" and "Heart · strap".
   - The only HR data in the repo is `fixtures/hr_a07_synthetic.csv` (synthetic). There are **no real HR or node CSVs** on any branch or on disk.
4. **Collapse and Response show measurements nobody took.**
   - Collapse shows a synthetic tub probe (48.6–55.8 °F), and that value is copied into the EMS hand-off text.
   - Response shows a pre-ticked checklist: "Probe reads 48.9 °F", "Tub within 1 minute", "Checked 3:05 PM".
5. **Voice Q&A (my `voice-twin`) lets a hosted LLM compose the spoken reply.**
   - The guard and number-ledger check run *after* text-to-speech has started.
   - The check fails open when `/guard` is unreachable.
   - The ledger accepts any number seen in any tool JSON this session, including lat/lon and ids.
   - The voice tools answer about the **fixture plan, not the plan on screen**.
6. **Gemini on `llm-bridge` (Jack) is plan entry, not Q&A.**
   - One call does speech-to-text and plan structuring.
   - It produces drill durations and inferred intensity, gear and priority. These are listed as `assumptions`, and the coach must confirm them.
   - It produces **no heat numbers**.
   - It is not wired into any screen.
   - There is no Gemini in the Q&A path on any pushed branch.
7. **Merging ws1 will change demo numbers unless demo mode pins the forecast.**
   - `engine/api.py::_forecast_for` will start using ws1 `weather.get_forecast()`. That fetches live NWS (10 s timeout) and writes a cache file on every call, including `?demo=1`.

---

## 1. Branches

| Branch | Head | Author | vs main | Contents |
|---|---|---|---|---|
| main | 0df1470 | ehanrsha | n/a | Kit (c45c386) merged with webapp (unrelated history). Old 88-line `constants.yaml`; `planning_limit_core_c` is TODO there |
| webapp | b343a4b | ehanrsha | merged | React app: Plan, Live roster, Athlete twin, Response, Collapse. Browser stand-in model |
| ws2-physio | 07e33d3 | me | +31 / −3 | Two-node model, optimizer, API (/simulate, /optimize, /what_if, /athlete_status, /field_conditions, /live/start, /hr, /guard, /settings, /sources), guard, calibrate, hr_bridge, validation. 125 tests |
| ws1-weather | 1f980ab | Jack | +9 / −3 | `weather.py` (NWS → WeatherHour, cache), `wbgt.py` (Liljegren port + C reference cases), `fhsaa.py` (Policy 41, verified; also `acclimatization_violations`, `advisories`), `assimilate_env`. Based on early ws2 (915aac2). **No HTTP routes** (/weather, /node, /node/latest are not implemented anywhere) |
| llm-bridge | b63ee4a | Jack | +33 / −3 | ws2-physio plus 2 commits: `engine/llm_plan.py`, `engine/llm_routes.py` (/plan/parse, /plan/parse_audio, /plan/llm_status), `web/src/data/llmPlan.ts`, `web/src/lib/useVoicePlan.ts`, tests, `docs/LLM_BRIDGE.md`, `.env.example`. No web app on this branch; the two TS files are not imported anywhere |
| voice-twin | e01b774 | me | +2 / −2 | Off webapp: `web/src/voice/*` (ElevenLabs agent with client tools, ledger, text fallback, 8 scripted questions), `<VoicePanel/>` mounted in PlanView |
| **voice-plan** | — | — | — | **Not on origin.** Needs a push, or a confirmation that `llm-bridge` is it |
| hardware | — | — | — | Not on origin. `hr_bridge.py` is on ws2-physio |

**Merge conflicts** (`git merge-tree --write-tree`):

| Merge | Result |
|---|---|
| ws2-physio + main | 1 conflict: `.claude/launch.json` (add/add). Trivial |
| ws2-physio + ws1-weather | 1 conflict: `engine/constants.yaml` tail. Both sides append blocks (ws2: optimizer…drill_duty_cycle; ws1: `assimilation`). Keep both. ws1's VERIFIED `fhsaa_wbgt_zones` and new `fhsaa_practice_limits` auto-merge. `fhsaa_adapter.py` auto-merges to the ws2 version (roster-aware) |
| llm-bridge + ws1-weather | Same `constants.yaml` tail conflict |
| ws2-physio + llm-bridge | Clean (llm-bridge is ws2 + 2) |
| main + voice-twin | Clean |
| ws2-physio + voice-twin | Unrelated histories; goes cleanly through main |

**Semantic (non-textual) merge issues:**

- **FHSAA implementation.** After ws1 lands, `fhsaa_adapter` picks `engine/fhsaa.py` over the stub. The zone numbers are identical, but the violation rules and texts may change, so the demo numbers and PLAN §7 must be re-run.
- **Gear phasing is checked twice.** ws1 `fhsaa.acclimatization_violations` (FHSAA §41.5.7 gear by practice day) overlaps ws2 `gear_rules.phasing_violations` (NATA 2009). Both use days 1–2 helmet, 3–5 helmet + shoulder pads, 6+ full. Wire one and cite both, or violations will be counted twice if someone wires both.
- **Live NWS in demo mode.** ws1 `get_forecast` fetches live NWS. See finding 7.

---

## 2. What the "voice-plan" work changed

The `voice-plan` branch can't be seen. The Gemini voice work on origin is `llm-bridge` (Jack, dec7cb7 and b63ee4a):

- **Browser:** `useVoicePlan` records the mic, converts it to 16 kHz mono WAV (Chrome's webm isn't accepted by Gemini) and sends `POST /plan/parse_audio`. A text path uses `POST /plan/parse`.
- **Engine:** `llm_plan.py` calls Gemini `generateContent` (default `gemini-3.1-flash-lite`, temperature 0.1) with a response JSON schema: `transcript`, `start_time_local`, `drills[name, duration_min, intensity, gear, is_break, shade, priority, movable]`, `assumptions`, `unclear`.
- **Draft plan:** `draft_plan()` turns the response into a `PracticePlan` with ids `d#`/`b#`. Drills with no duration are dropped into `unclear`. `assumptions` and `unclear` pass through `guard.check`. It returns `{plan, transcript, assumptions, unclear, total_min, needs_confirmation: true, labels: ["parsed by AI from the coach's description — coach must confirm"], model}`.
- **Key handling:** the key lives in `.env` (gitignored) on the engine only. It is never in the browser, and was not found in any commit.
- **Not done:** nothing renders the draft or the confirm step, and nothing calls /simulate with the confirmed plan. There is no web app on the branch.

**Numbers the LLM produces:**

- `duration_min` comes from the coach's words.
- `intensity`, `gear` and `priority` are inferred when unstated, and each inference is listed in `assumptions`.
- `start` comes from the spoken time.
- Inferred intensity then drives MET through the engine's Compendium table. So an LLM guess becomes a heat input until the coach confirms it. Acceptable only with the confirm step (fix list #11).

---

## 3. Data flows (as built today)

### (a) Coach plan entry → optimization

**On `main` (what the demo currently shows):**
```
fixed TS PLAN (fixtures.ts, 118 min, 9 drills, web METs 1.4–6.4)   ← no plan entry
  → model.simulate() per athlete × PRIOR_FACTOR (literal table)      ← STAND-IN
  → optimizer.checkRules() with web ZONES (wrong cut-offs)           ← WRONG
  → "Optimize" → optimizer.optimize(): strip breaks, conditioning to slot 2, all full pads→shells,
     trim to 120−8×3 min, 8 × 3-min breaks, sit out anyone ≥ 38.9   ← STAND-IN / UNSOURCED
  → "Use for today" → engine.setPlan() (sit-outs dropped)
```
**Engine path that exists but isn't wired:**
```
coach voice/text → /plan/parse(_audio) [Gemini: words → drills JSON] → draft + assumptions → coach confirms
  → POST /simulate?demo=1 {plan, roster}  → SimulationResult (p50/p95 per athlete, FHSAA+NATA violations, labels)
  → POST /optimize?demo=1&preset=…        → OptimizeResult (plan, changes, top_changes(_text), load_kept_pct, labels)
```

### (b) Observing a player

**On `main`:**
```
requestAnimationFrame loop (engine.ts) at 1×/4×/10×
  truth   = stepCore(…, TRUE_HEAT_FACTOR)          ← hidden "answer"
  HR      = heartRate(truth) + noise               ← SYNTHETIC, shown as "Heart · strap"
  est     = physics + 0.45·(truth + noise − physics); factor += 0.9·gap   ← circular "calibration"
  forecast= model.simulate() from now; band = 0.06 + 0.024·√h (×0.55)     ← UNSOURCED "p95"
```
**Engine path that exists but isn't wired:**
```
Amazfit Helio strap (BLE 0x180D/0x2A37) → hr_bridge.py → POST /hr {athlete_id, ts, hr_bpm, replay}
  → LiveSession: HR→MET via %HRR (Swain 1997), EnKF on met_scale, gates (persistence 3 min, ≥2 updates, coverage ≥0.5)
  → reforecast SimulationResult + gates + labels
replay: POST /live/start then hr_bridge --replay fixtures/hr_a07_synthetic.csv  (only HR file; synthetic)
```

### (c) Voice

The flow asked for is: mic → Gemini transcription → intent → endpoint → display/speak.

**Q&A on `voice-twin`, agent mode:**
```
push-to-talk → ElevenLabs hosted agent (its own STT + LLM + TTS)
  → client tool call → engine (/simulate?demo=1, /optimize?demo=1, /what_if, /athlete_status, /field_conditions)
  → JSON + `say` (engine-guarded for what_if/athlete_status/field_conditions; built in the browser for simulate/optimize)
  → agent LLM writes its own sentence → TTS starts speaking
  → (in parallel) POST /guard + NumberLedger on the text → if flagged: volume 0, "restate", transcript shows redacted text
```
**Q&A on `voice-twin`, text fallback:**
```
typed → regex route() → tool → `say` → /guard + ledger → transcript (no TTS)
```
**Plan entry on `llm-bridge`:** see (a). Gemini transcribes and structures in one call; there is no intent step.

---

## 4. Number and claim table

### 4.1 Web app on `main`

**Plan screen**

| What's shown | Source | Verdict |
|---|---|---|
| "3:30 PM – 5:28 PM" | `PRACTICE_START_HOUR` 15.5 + TS plan 118 min | Start matches; length **WRONG** vs engine plan (113 min) |
| Drill blocks, minutes and gear | TS `PLAN` (different drills from `fixtures/plan.json`; ids d1–d9 mean different drills) | **WRONG** (not the engine plan) |
| Drill MET 1.4–6.4 ("PHS met, 58.2 W/m²") | `fixtures.ts:31-41` | **UNSOURCED**. Engine uses Compendium mass-specific METs 1.3/2.8/4.0/8.0/11.0 (`constants.yaml:84-89`) |
| WBGT colour strip | TS `FORECAST` (87.6/88.4/87.2/84.9/81.8 °F) + web `ZONES` | **WRONG**. NWS fixture says 86/83/82; zones are wrong |
| "Forecast over the line N" | `model.simulate()` median × `PRIOR_FACTOR` | **STAND-IN**. Engine (`/simulate?demo=1`): 16 of 16 over the 39.0 °C line by p95 |
| "Hottest forecast X.X°" (no unit) | stand-in median | **STAND-IN**. Engine max p95 41.65 °C |
| "FHSAA issues N" and chips ("zone needs 8") | `checkRules` + web zones | **WRONG**. Engine: 2 (zone-2 breaks per hour) |
| "✓ Meets FHSAA red zone rules" | literal text | **WRONG** (claims compliance against a wrong table) |
| "Training load kept %" (before = literal 100) | Σ MET × min | **STAND-IN**. Engine `load_kept_pct` 75.3 (priority-weighted) |
| Per-athlete peak and strip colours (37.0/37.7/38.3/38.8/39.3) | stand-in + `heat.ts` stops | **STAND-IN / UNSOURCED** |
| "What changed" (pads→shells, 120 min, 3-min breaks, 30 % trim, sit-out ≥ 38.9) | `optimizer.ts` literals | **UNSOURCED / WRONG**. FHSAA breaks are 4 min; engine gives 18 changes (`top_changes_text` lists the top 3) |
| "Forecasts use each athlete's heat factor from previous sessions…" | literal | **WRONG**. `PRIOR_FACTOR` is a literal table |
| Names, numbers, kg, cm, Day N | TS `ROSTER` (12; not marked fictional) | **WRONG** vs engine roster (16, "(fictional)") |

**Live roster (Coach) screen**

| What's shown | Source | Verdict |
|---|---|---|
| "Now 3:42 PM", playhead | synthetic clock | **SYNTHETIC** (looks live) |
| "FHSAA zone: Red" at about 88 °F | web zones | **WRONG**. 88 °F is zone 3 (87.1–90.0) |
| HR "N bpm" | `heartRate(truth)` + noise | **SYNTHETIC** |
| "Est. core X.X°", peak, sparkline, band | stand-in + `bandFor` | **STAND-IN / UNSOURCED**. The band is not a p95 |
| Status: watch at 38.5 or median peak ≥ 39.0; alert after 2 min; clears below 38.7 | `constants.ts` | **WRONG** vs engine: near_limit at p95 ≥ 38.7 (`near_limit_margin_c` 0.3, :280), persistence 3 min, ≥2 updates, coverage 0.5 (:508-510), no hysteresis |
| "Day N" with 14 ticks | fixture + 14 | **OK-CONST** (acclimatization 14 days) |
| "Do this now" steps | literal | **UNSOURCED** (treatment copy; needs a KSI/NATA citation and AT review) |

**Athlete twin screen**

| What's shown | Source | Verdict |
|---|---|---|
| "X °F · ±Y° (p95)" | stand-in + `bandFor` | **STAND-IN / UNSOURCED** |
| "Model: Calibrated from live HR" (after `hasStrap && minute > 5`) | literal rule | **WRONG** (HR is synthetic; the engine's gates differ) |
| Body-figure gradient (core −0.35/−0.9/−1.6 °C) | literals | **UNSOURCED** (nothing models limb temperature) |
| "BSA X.XX m²" | DuBois in TS | **OK-CONST** (matches engine within 0.2 %) |
| Acclimatization notes ("Early days carry the most risk…") | literal | **UNSOURCED** |
| Safety line | `SAFETY_LINE` | Wording OK |

**Response and Collapse screens**

| What's shown | Source | Verdict |
|---|---|---|
| Response ✓ "Probe reads 48.9 °F", "Tub within 1 minute", "Gate 3 unlocked", "Checked 3:05 PM" | literals, `ok: true` | **WRONG / SYNTHETIC**. Nobody checked these; the engine's `tub_within_min_of_field` is [5, 10] |
| Collapse "Tub water · probe X.X °F" (and in the EMS hand-off) | `48.6 + min(7, 0.012·s) + 0.15·sin` | **SYNTHETIC**. No probe exists; the contract has `tub_temp_c` on node readings, but there's no node |
| Collapse "Under 60 °F — cold enough" | 60 °F | ≈ KSI 15 °C (59 °F); always true because the synthetic value tops out at 55.8 |
| Collapse "Cool within 30:00" | literal | Partial: NATA says below 102.5 °F within 30 min (`constants.yaml:43`); the temperature goal is missing |
| Collapse "10–15 min without a rectal reading" | literal | **OK-CONST** (`ksi_cwi` [10, 15]) |
| Collapse "Since collapse mm:ss" | wall clock from the button press | Mislabelled (it's time since the button press) |

**Shared elements**

| What's shown | Source | Verdict |
|---|---|---|
| FieldCard "WBGT · field X.X °F" | TS forecast | **WRONG label** (forecast, not a field reading) |
| DemoBar "Replay" | synthetic loop | **WRONG label** (nothing recorded is replayed) |
| "Coach Reyes · no AT on site" | literal | **UNSOURCED** persona (fine if labelled demo) |

### 4.2 Voice Q&A (`voice-twin`)

| Number or claim | Source | Verdict |
|---|---|---|
| `simulate_plan` say: "N of M athletes … over the 39.0 °C line. First: X at minute T. K FHSAA issues" | numbers from `/simulate?demo=1`; sentence built **in the browser** | Numbers ENGINE; sentence not engine-guarded before the agent sees it |
| `optimize_plan` say (top_changes_text, load %, changes, over after) | `/optimize?demo=1`; sentence partly built in the browser | Numbers ENGINE |
| `what_if` before/after, delta, say | `/what_if` (engine-guarded `say`) on the **fixture plan** | ENGINE but **wrong plan** (doesn't send the on-screen plan) |
| `athlete_status` peak p50/p95, minute, status | `/athlete_status` GET (fixture plan only) | ENGINE but **wrong plan**; labels drop "synthetic plan/roster", "forecast is fixture" |
| `field_conditions` WBGT, zone, source | `/field_conditions` (fixture forecast; labelled) | ENGINE |
| Add-break default "4 min" | `localAnswer.ts` and `voice_tools.apply_change` literals | Value = FHSAA `break_min` 4, but **hard-coded** instead of referenced |
| Drill name → id (gassers → d6, …) | `localAnswer.ts` literal map | **WRONG** for any plan other than the fixture (web ids d1–d9 mean different drills) |
| Agent reply text and speech | ElevenLabs agent LLM | **LLM-composed**; checked after TTS has started |

### 4.3 LLM plan entry (`llm-bridge`)

| Field | Source | Verdict |
|---|---|---|
| duration_min, start time | Gemini, from the coach's words | OK with the confirm step (no confirm UI yet) |
| intensity, gear, priority, movable, shade (when unstated) | Gemini inference, listed in `assumptions` | **LLM-inferred heat inputs**: must be shown and confirmed |
| `toUiDrills(metFor)` / `uiKind` | TS helper | Would feed web stand-in METs; delete when the web uses engine shapes |

### 4.4 Engine outputs and docs

| Item | Verdict |
|---|---|
| `/simulate?demo=1`: 16/16 over 39.0 °C by p95, max p95 41.65 °C, 2 FHSAA (zone-2 breaks), WBGT 86/83/82 °F (fixture) | ENGINE |
| `/optimize?demo=1`: feasible, 75.3 % load, 18 changes, 0 over, max p95 38.98 °C, 0 FHSAA | ENGINE |
| `fewest_changes`: no plan within 6 changes meets every rule, so it shows the 18-change max_load plan (labelled) | ENGINE; matches PLAN §7 |
| PLAN §7 numbers | Match the current engine output |
| Model vs field pill data: medians 1.4–1.7 °C hot (`validation/results.json` `field_plausibility`) | Documented ("errs hot") |
| `validation/results.json` | Holds only `armstrong_2010` and `field_plausibility`. **There are no demo numbers for the app to match yet** |

---

## 5. Flags

### 5.1 Stand-ins, mocks and hard-coded numbers

**Web (main):**
- **Stand-in model** (`model.ts`): `GEAR_EVAP` 1.0/0.84/0.68, acclimatization 0.72 + 0.28·d/14, environment (97 − WBGT)/17, break ×1.35, loss coefficient 520, offset 36.8, floor 36.6.
- **Fake live loop** (`engine.ts`): filter gain 0.45, factor gain 0.9, clamp [0.8, 1.6], noise.
- **Fixture tables:** `PRIOR_FACTOR`, `TRUE_HEAT_FACTOR`.
- **Stand-in optimizer** (`optimizer.ts`): 120 / 3 / 4 / 30 % / 38.9 / sit-out MET 1.6 / break MET 1.4.
- **Thresholds and display constants:** `THRESHOLDS`, `ZONES`, `heat.ts` colour stops, band formula, body-figure offsets.
- **Response and Collapse:** pre-ticked checklist, synthetic tub temperature.

**Voice (voice-twin):**
- Browser-built `say` sentences.
- Literal 4-minute break.
- Literal drill-id map.

**Engine (ws2-physio, mine):**
- `voice_tools.apply_change` default `minutes=4`, inline.
- `/athlete_status` has a `demo` query parameter it ignores.

### 5.2 An LLM producing or rewriting numbers
- **ElevenLabs agent (voice-twin):** rewrites tool numbers into its own sentence. Rounding, units and context are not guaranteed, and the check runs after speech starts.
- **Gemini (llm-bridge):** produces plan inputs (durations, inferred intensity/gear/priority). It produces no outputs, and coach confirmation is required, but there is no UI for that yet.
- **Not found:** nothing found where an LLM computes heat numbers.

### 5.3 Voice paths that bypass the guard or the number ledger
1. **Agent mode, timing:** the guard and ledger run on the reply text as it arrives. The first words can be heard before a hit mutes the volume.
2. **Fails open:** `checkReply` shows the raw text when `/guard` fails (`g === null`). It should hold the reply instead.
3. **Weak ledger:**
   - It is session-wide, so a number from a different athlete or question passes.
   - It accepts every number in the JSON, including lat/lon, ids, years and ISO times.
   - `forms()` drops the sign and allows 1–2 decimal rounding.
4. **Unguarded tool text:** the `simulate_plan` and `optimize_plan` `say` sentences are built in the browser, not passed through `engine/guard.py` before the agent reads them.
5. **Unguarded Gemini transcript:** the llm-bridge `transcript` is not guarded. It is the coach's own words, so this is acceptable if it's shown as a quote.

### 5.4 CONTRACTS v1.2 mismatches
- **Routes:**
  - In CONTRACTS but implemented on no branch: `/weather`, `/node`, `/node/latest`. ws1 has the functions (`node_hour`, `assimilate_env`) but no routes.
  - Implemented but missing from CONTRACTS: `/plan/parse`, `/plan/parse_audio`, `/plan/llm_status` (documented only in `docs/LLM_BRIDGE.md`).
- **Web `types.ts` is a different schema:**
  - Drill: `kind`, `minutes`, `met` (W/m² METs), and `Gear` = helmet | shells | full, with **no `none`**.
  - Athlete: `massKg`, `heightCm`, `acclimDay`, `hrRest`, `hrMax`, `hasStrap`, `number`.
  - WeatherHour: `hour`, `tempF`, `rh`, `windMph`, `wbgtF`, and `source` = forecast | field-node.
  - It has no `fhsaa_zone`, `labels`, p95 or `status`.
- **Voice endpoints:**
  - `/athlete_status` and `/field_conditions` are GET-only, with no `plan`/`roster`/`settings` body. They can't describe the on-screen plan.
  - `/what_if` and `/athlete_status` responses drop the fixture provenance labels.
- **`?demo=1` scope:**
  - `/simulate?demo=1` also sets `n_ensemble` from `demo_mode`; the contract says only "fixes the seed".
  - `/what_if`, `/athlete_status` and `/field_conditions` have no `?demo` (they use seed 0 by default).
- **llm-bridge `ContractDrill`:** lacks the optional `drill_type`, `gear_by_athlete` and `met_override`. Harmless.

### 5.5 Data used per screen, and whether labels say so

| Screen | Plan | Roster | Weather | HR | Engine? | Does the label say so? |
|---|---|---|---|---|---|---|
| Plan | TS fixture | TS (12) | TS literal | n/a | no | No: no "fixture", "synthetic" or "fictional"; claims "previous sessions" |
| Live roster | TS / optimizer output | TS | TS literal | synthetic | no | No: shows "Now", "strap", "Replay" |
| Athlete twin | same | same | same | synthetic | no | No: shows "Calibrated from live HR" |
| Response | n/a | n/a | n/a | n/a | no | No: pre-ticked "checked" items |
| Collapse | n/a | n/a | n/a | n/a | no | Tub temperature is synthetic and unlabelled; estimate line says "estimate, not a measurement" (good) |
| Voice panel (voice-twin) | engine fixture | engine fixture (16) | NWS fixture | n/a | yes | Partly: "estimate — planning only"; `what_if`/`athlete_status` drop the fixture labels |

### 5.6 Branch conflicts
See §1: two trivial textual conflicts, plus the semantic issues (FHSAA implementation switch, live NWS in demo mode, double gear-phasing checks, different drill ids between the web and engine plans).

---

## 6. Prioritized fix list, for approval

These are proposed for a new branch `audit-fixes`.

**Base branch.** You asked for `audit-fixes` off `voice-plan`, which isn't on origin. Until it's pushed I'd base on `main`, merging in this order: `ws2-physio` → `ws1-weather` → `llm-bridge` → `voice-twin`. **Nothing goes to main** until you approve.

**P0: wrong or misleading, and demo-blocking**

1. **Web reads only engine numbers** (your b).
   - Add `web/src/engine/` with a typed client: `/simulate?demo=1`, `/optimize?demo=1&preset=`, `/what_if`, `/athlete_status`, `/field_conditions`, `/live/start`, `/hr`, `/settings`.
   - Plan, Live roster and Athlete twin render `SimulationResult`/`OptimizeResult` directly, using p95 and `status`.
   - Move `model.ts`, `optimizer.ts` and `engine.ts` to `web/src/offline/`. They're used only when the engine is unreachable, behind a red **OFFLINE FALLBACK — not the validated model** badge on every number.
   - Needs one additive endpoint, `GET /demo/inputs` → `{plan, roster, weather, labels}`, so the screen shows the plan and roster the engine simulated. (Contract v1.3, additive.)
2. **FHSAA zones from the engine.**
   - Delete the web `ZONES` table. The zone comes from `WeatherHour.fhsaa_zone`, violations from `fhsaa_violations`, and rule text from `/sources`.
   - Remove "Meets FHSAA red zone rules" unless `fhsaa_violations` is empty, and then word it as "0 FHSAA issues found by the engine".
3. **No synthetic data presented as real.**
   - Live roster and Athlete twin are driven by `/live/start` + `/hr` replaying `fixtures/hr_a07_synthetic.csv`. Label: "replay of a synthetic HR file (a07) — not a real athlete".
   - Athletes without HR show the plan forecast only.
   - Remove `TRUE_HEAT_FACTOR`, `PRIOR_FACTOR`, "Calibrated from live HR", "Heart · strap" and "previous sessions".
4. **Collapse and Response: no invented readings.**
   - Remove the synthetic tub temperature, from both the screen and the EMS hand-off. Show "no tub probe connected" until a node posts `tub_temp_c`.
   - The Response checklist becomes unchecked items the user ticks.
   - Show NATA's below-102.5 °F-within-30-min goal and cite KSI/NATA constants on each protocol step (for AT review).
5. **Voice rebuilt as Gemini intent → engine → guard → TTS** (your a).
   1. Gemini transcribes and returns `{intent, slots}` only, against a response schema. Intents: `plan_summary`, `optimize`, `what_if`, `athlete_status`, `field_conditions`, `unknown`. The schema is also validated server-side, and nothing numeric is accepted from Gemini except slot values that are checked against the current plan (drill id, athlete id, minutes within AT limits).
   2. The engine runs the endpoint and builds the `say` sentence itself. This adds `say` for plan summary and optimize on the engine.
   3. The browser runs `/guard` plus a **per-answer** ledger, limited to that answer's numeric fields, **before** display or TTS.
   4. If `/guard` is down, the reply is held, not shown or spoken (fail closed).
   5. TTS is ElevenLabs TTS through an engine proxy (key on the engine), or browser `speechSynthesis` as a fallback. The ElevenLabs Conversational agent is dropped.
   6. Push-to-talk and text input share the same path.
6. **Voice and what-if act on the on-screen plan.**
   - Add POST variants of `/athlete_status` and `/field_conditions` that take `{plan, roster, settings}` (additive). `/what_if` gets the current plan.
   - Drill and athlete names are resolved on the engine against that plan. The literal id map is removed.
7. **Demo mode pins the forecast** after the ws1 merge.
   - `?demo=1` → `get_forecast(offline=True)`, the cached NWS fixture, labelled.
   - Live NWS only without demo mode, and no cache write per request.
   - Re-run the §7 numbers after the merge (ws1 `fhsaa.py` replaces the stub).

**P1**

8. **Provenance labels on every view** (your c).
   - Every screen shows the response's `labels`: "synthetic plan (fixture)", "synthetic roster", "forecast is fixture", "AT-owned settings…", "uses unverified constants…".
   - Fix `/what_if` and `/athlete_status` to pass them through.
   - Show "(fictional)" on names.
   - FieldCard says "forecast" (not "field") unless `source = field_node`.
9. **Thresholds from engine settings** (`/settings`): limit 39.0, near band 0.3, persistence 3, coverage and update gates. Remove the web `THRESHOLDS`.
10. **Hard-coded voice/what-if values become references:** the default break length becomes the zone's `break_min` from constants, at the drill's hour.
11. **Gemini plan-entry confirm UI.**
    - Show the transcript, the drills, every `assumptions` item as "Check:" and every `unclear` item.
    - Simulate only after "Confirm".
    - Delete `toUiDrills`/`uiKind` (web METs).
12. **CONTRACTS v1.3 (additive).** Add:
    - `/plan/parse*` and `/plan/llm_status`;
    - `/demo/inputs`;
    - the POST variants of `/athlete_status` and `/field_conditions`;
    - the voice intent schema;
    - a note marking `/weather`, `/node` and `/node/latest` as not implemented.
13. **Data wiring (your d).**
    - There are no real node or HR CSVs. Wire the synthetic HR replay with its label, and add a `/node` route only if Teammate 2 has a CSV.
    - `results.json` has no app numbers yet, so I'd add `validation/results.json → demo` (headline numbers from `/simulate?demo=1` and `/optimize?demo=1` for both presets, written by a script) and make the end-to-end test assert that the UI and voice show those exact values.

**P2**

14. **End-to-end test (your e).**
    - The 8 scripted voice questions run with a recorded/mocked Gemini intent, the real engine, and the guard and ledger asserted. Gemini live is optional with a key.
    - Plus 5 plan/player actions: load plan, optimize max_load, optimize fewest_changes, what-if add break, start HR replay and read one athlete.
    - All numbers are compared with `results.json → demo`.
15. **Merge plan** (your step 4).
    - Order: ws2-physio → ws1-weather (keep both constants blocks; one gear-phasing check) → llm-bridge → voice-twin, then voice-plan once pushed.
    - Resolve conflicts in favour of engine-backed code.
    - Run the engine tests, web `tsc`/`vitest`, and the `demo-qa` agent.
16. **Copy review:**
    - "Steady" → "below line".
    - "Since collapse" → "since alert pressed".
    - The diagnosis wording in Collapse ("suspected exertional heat stroke" for the 911 script) is kept only as quoted EMS-call wording with a source. It needs AT sign-off.

---

## 7. What I could not verify

- **The `voice-plan` branch:** not on origin. Everything about "Gemini for speech-to-text" here is from `llm-bridge`. If voice-plan has Q&A changes, this audit hasn't seen them.
- **A hardware branch:** none exists. The node firmware, node CSV and any real HR recordings are absent. I couldn't check the field-node numbers or real strap data.
- **Gemini behaviour:** not called (no key used). Whether `gemini-3.1-flash-lite` transcribes sideline audio accurately, and its "identical drills" claim in b63ee4a, are untested by me.
- **ElevenLabs agent:** not run live. The "first words audible before a hit" timing is from the code path, not measured.
- **Web app:** not rendered in a browser. The inventory is from source (Explore agent plus my own read of `data/*`), so the on-screen formatting may differ slightly from the expressions quoted.
- **ws1 `fhsaa.py` violation texts and counts:** not run against the demo plan, so the post-merge §7 numbers are unknown until the merge.
- **Clinical copy** (Collapse, Response, Coach "Do this now"): I can check citations, but not clinical appropriateness. That needs the AT.

---

## Addendum (18:35): branch state when fixes started

- **`voice-plan` was pushed and fast-forwarded into `main`** (19c17ef, ehanrsha). It adds a Gemini plan-entry dock with a confirm step (`VoiceDock`, "Kelvin"), a plan editor, and `planStore`, which calls `/simulate?demo=1` and `/optimize?demo=1` with the plan.
  - The web now uses the engine's p50/p95 once a plan is confirmed.
  - The stand-in model, the fake HR truth, the web `ZONES`/`THRESHOLDS` and the Collapse/Response literals are still there. P0 items 1–4 still apply.
- **`ws6-firmware`** (Jack) = ws1-weather + `engine/node_bridge.py` (Uno globe thermistor → field WBGT → `data/node_<date>.csv`) + `firmware/`. This is the "hardware branch".
- **`audit-fixes` = main + ws6-firmware + voice-twin.**
  - `constants.yaml`: both blocks kept.
  - `PlanView.tsx`: main's version kept. The voice-twin `<VoicePanel/>` mount was dropped because P0-5 replaces it.
- **Demo numbers after ws1's verified `fhsaa.py` replaced the stub** (forecast pinned):
  - The baseline is unchanged: 16/16 over 39.0 °C by p95, max p95 41.65 °C, 2 FHSAA issues.
  - `/optimize?demo=1` is now feasible, 70.7 % load kept, 21 changes, 128 min, 0 over, 0 FHSAA. It was 75.3 % / 18 changes with the stub.
  - PLAN §7 needs a refresh (item 13).
