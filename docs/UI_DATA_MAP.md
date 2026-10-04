# UI data map — voice-plan UI (final-ui)

Every number, zone, status and sentence the voice-plan web UI shows, where it comes from **now** (web/ at
`origin/voice-plan` 46a006b, as imported on `final-ui`), and where it **will** come from after the rewire.
"label" = static copy or a provenance label (no model output). File:line refer to `web/src/` before the rewire.

Source codes used below:

| Code | Meaning |
|---|---|
| **HC** | hard-coded literal in a component |
| **TS** | in-browser heat model / rules: `data/model.ts` (single-node stand-in, "tuned by eye"), `data/optimizer.ts` (`checkRules`, `forecastRoster`, `PRIOR_FACTOR`), `data/constants.ts` (`THRESHOLDS`, `ZONES` with unverified FHSAA cut-offs) |
| **FAKE** | the fake live loop `data/engine.ts`: hidden "true" heat (`TRUE_HEAT_FACTOR`, `fixtures.ts:52`), a Kalman-style nudge toward it, fake HR from `model.ts:105 heartRate()` + sine noise |
| **MOCK** | invented UI data: jersey numbers (`fixtures.ts:25`), who has a strap (`fixtures.ts:29`), readiness checks, tub-probe formula |
| **FIX** | fixture JSON imported by the browser (`fixtures/plan.json`, `fixtures/roster.json`) |
| **NWS-B** | the browser fetching api.weather.gov and converting units itself (`data/weather.ts:87`) |
| **GEM** | Gemini via the engine's `/plan/parse*` (draft plan, transcript, assumptions, change sentences) |
| **ENG** | an engine response (`/simulate`, `/optimize`) — only after a voice / edited / optimized plan |
| **CALC** | browser arithmetic on one of the above (counts, unit conversion, max) |

Engine fields below use CONTRACTS.md names. `sim` = `SimulationResult` of the plan on screen (`POST /simulate?demo=1`,
or `OptimizeResult.optimized`); `curve` = the athlete curve in force at the minute (live re-forecast, replay frame, or
`sim`); `m` = practice minute.

## Shared: session clock, roster, weather

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 1 | Roster names | "Marcus" | FIX `fixtures.ts:33-35` ("(fictional)" stripped) | `GET /demo/inputs` → `roster[].name`; screens carry a "synthetic roster" label when `synthetic.roster` |
| 2 | Jersey number badges (roster row, picker, vitals, plan strip, alert card, Collapse) | "72" | MOCK `fixtures.ts:25-28,36` | `roster[].position` in the same badge ("OL") |
| 3 | Position · mass · height | "OL · 125 kg · 188 cm" | FIX `fixtures.ts:37-39` | `/demo/inputs` `roster[].position`, `mass_kg`, `height_m` (×100 for cm) |
| 4 | Acclimatization day | "Day 5" | FIX `fixtures.ts:40` | `roster[].acclimatization_day` |
| 5 | Acclimatization period length (ticks, "of 14") | 14 | HC `CoachDashboard.tsx:342`, `AthleteView.tsx:277,283` | `GET /sources` → `nata_ehs.acclimatization_days` (max) |
| 6 | Has-strap flag ("No strap · model") | 4 athletes without | MOCK `fixtures.ts:29,44` | athletes in the HR replay file (`/live/replay` `source.athletes`) or mapped on `/live/state` |
| 7 | HR rest / max | (drive fake HR) | FIX / Tanaka formula in browser `fixtures.ts:41-43` | removed (HR comes from the replay file or the strap) |
| 8 | Today's plan (drills, minutes, gear, order) | 9 blocks · 113 min | FIX `fixtures.ts:72-74` (+ voice / edit / optimize) | `/demo/inputs` `plan` at boot; voice draft (coach-confirmed), editor, or `/optimize` `plan`. Fixture JSON only while the engine is unreachable |
| 9 | Practice start | 3:30 PM | HC `fixtures.ts:84` (`PRACTICE_START_HOUR = 15.5`) | `plan.start` |
| 10 | Clock / current drill / min left / next break | "3:33 PM", "8 min left", "28 min" | CALC on FIX plan, demo clock `engine.ts:213-218` | same plan arithmetic on the engine plan; clock = demo playback, or `GET /live/state` `minute` when a strap is live |
| 11 | Hourly forecast (WBGT per hour) | 87.6, 88.4 … °F | HC `fixtures.ts:76-82` (`FORECAST`) | `sim.weather[]` (`wbgt_f`, `fhsaa_zone`, `source`) |
| 12 | WBGT at the minute | 88.0 °F | TS interpolation `model.ts:18-29` | the engine `WeatherHour` that contains minute `m` (no interpolation) |
| 13 | FHSAA zone | "Red" / "Limit intensity" | TS `constants.ts:21-33` (`zoneFor`, wrong cut-offs: 80/85/87.1/90.1) | `WeatherHour.fhsaa_zone`; rule text from `GET /sources` → `fhsaa_wbgt_zones.zones[]` |
| 14 | Estimated core per athlete per minute | 37.2 °C | FAKE `engine.ts:180-211` (TS `stepCore` × hidden factor, or engine p50 bent by `TRUE_HEAT_FACTOR/PRIOR_FACTOR`) | `curve.core_c_p50[m]` |
| 15 | Forecast curve | dashed line | FAKE/TS `engine.ts:225-238` (`simulate()` re-run from the fake estimate) | `curve.core_c_p50` |
| 16 | p95 band | ±0.08° | TS `model.ts:100-103` (`bandFor`) or engine p95−p50 × 0.6 "calibrated" fudge `engine.ts:232` | `curve.core_c_p95 − core_c_p50` |
| 17 | Heart rate | 115 bpm | FAKE `model.ts:105-110` + noise `engine.ts:201` | `POST /live/replay?demo=1` → `hr_series[id]`; live: `GET /live/state` → `athletes[id].hr_bpm` |
| 18 | Predicted peak + minute | "peak 39.1° @ 74′" | CALC `peakOf` on FAKE forecast `engine.ts:239` | `curve.peak_core_c_p95` (2 decimals, rounded like Python) + minute of the p95 maximum |
| 19 | Status (Steady / Watch / Over line) | pill | TS thresholds `engine.ts:240-242`, `constants.ts:9-15` (38.5 / 39.0 placeholders) | `curve.status` (`below_limit`/`near_limit`/`over_limit`) → pill styles steady / watch / alert |
| 20 | Alert (latched) + minutes over line | alert card, sidebar badge | TS persistence gate `engine.ts:206-208` (`persistMin: 2`, `clearBelowC: 0.3`) | engine gates: replay frame / live `gates.flag` |
| 21 | Planning line | 39.0° | HC `constants.ts:11` (`THRESHOLDS.alertC`) | `sim.limit_core_c` (AT setting, `GET /settings` `planning_limit_core_c`) |
| 22 | "Model: Engine · calibrated / calibrating…" | text | FAKE `AthleteView.tsx:84,163-164` (`minute > 5`) | `gates.coverage_ok` of the frame / live entry; label "HR replay" / "live · <device>" |
| 23 | Replay / live provenance | "Replay" tag only | HC `DemoBar.tsx:59` | `/live/replay` `source.label` ("replay · synthetic HR file (not a real athlete)" or "replay · <date> · <device>"); `/live/state` `labels` ("live · Amazfit Helio Strap") |

## Live roster (`views/CoachDashboard.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 24 | "Now · 3:33 PM" | clock | CALC `:135` | plan start + `m` (row 10) |
| 25 | Plan source chip | "Voice plan · engine forecast" | planStore `:136-139` | label (planStore source) + "offline fallback" badge |
| 26 | Drill name | "Dynamic warmup" | FIX/plan `:125,152` | plan drill at `m` |
| 27 | Min left · gear | "8 min left · Helmet" | CALC `:157-159` | plan arithmetic |
| 28 | Next break | "28 min" | CALC `:165-174` (`model.ts:47`) | plan arithmetic |
| 29 | FHSAA zone stat | "Red" | TS `:176-181` (`s.zone`) | `WeatherHour.fhsaa_zone` at `m` ("Zone 2") |
| 30 | Roster counts | "15 1 0" | CALC on TS/FAKE status `:44-47,182-188` | counts of `curve.status` |
| 31 | Timeline segments | colored bars | plan + TS kind (`llmPlan.uiKind`) `:193-205` | plan (display kind only) |
| 32 | Alert card: name, number, position, day | "Marcus #72 · OL · Day 5" | MOCK/FIX `:255-258` | roster (position, no number) |
| 33 | Alert card: core | 39.2 °C | FAKE `:261` | `curve.core_c_p50[m]` |
| 34 | Alert card: "Est. over 39.0° for N min · rising X°/min" | sentence | HC 39.0 + TS persistence count + CALC rate `:236,264-270` | `limit_core_c`, `curve.first_cross_min`, `curve.peak_core_c_p95` (no browser rate) |
| 35 | Guidance card | 3 steps + "Cool first…" | HC `:295-303` | label (static guidance, unchanged) |
| 36 | Row: HR | "115 bpm" / "No strap · model" | FAKE / MOCK `:348-358` | row 17 / "No strap · model" for athletes without HR |
| 37 | Row: est. core | "37.2°" | FAKE `:362` | row 14 |
| 38 | Row: peak | "peak 39.1° @ 74′" | CALC/FAKE `:365` | row 18 |
| 39 | Row: sparkline | chart | FAKE `:370-378` | rows 14–16 |
| 40 | Row: status pill | "Steady" | TS `:382` | row 19 |
| 41 | Row aria-label | "…estimated core 37.2 degrees, steady" | FAKE `:327` | same template, engine values |
| 42 | Footer | "Gainesville HS · Varsity · Estimates are…" | HC `fixtures.ts:85`, `:106-109` | plan site name (`plan.site.name`) + provenance labels (synthetic roster / HR replay / live · device) + the same sentence |

## Practice plan (`views/PlanView.tsx`, `components/PlanEditor.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 43 | Header times | "3:30 PM – 5:23 PM" | CALC on plan `:99` | plan arithmetic |
| 44 | Source chip | "Default plan" | planStore `:341-349` | label + "offline fallback" badge |
| 45 | Forecast over the line | 1 athletes | TS `forecastRoster` + `THRESHOLDS` `:61-73,146` (ENG only when a sim exists and no NWS location) | count of `sim.athletes[].status == over_limit` |
| 46 | Hottest forecast (p95) | 39.0° | TS `:74,147` | max `sim.athletes[].peak_core_c_p95` (2 decimals) |
| 47 | FHSAA issues | 2 | TS `optimizer.ts:59-75` (`checkRules`, invented zone limits) `:148` | `sim.fhsaa_violations.length` |
| 48 | Training load kept | 100% | HC `:149` / ENG `opt.load_kept_pct` | `OptimizeResult.load_kept_pct`; 100% = current plan (label) |
| 49 | "was N" under metrics | was … | ENG `opt.original` `:71` | `OptimizeResult.original` |
| 50 | Rule chips | "2 breaks scheduled — zone needs 8", "Full pads in a red-zone hour…" | TS `optimizer.ts:59-75` | `sim.fhsaa_violations[].detail` (engine text, shortened) |
| 51 | "Meets FHSAA red zone rules" | chip | TS `:197` (`zoneFor(peakWbgt)`) | highest `WeatherHour.fhsaa_zone` in the practice window |
| 52 | WBGT zone strip | colored cells | TS `:252-258` (`wbgtAt` + `zoneFor`) | `WeatherHour.fhsaa_zone` of the hour containing each cell |
| 53 | Strip row labels | "72 Marcus" | MOCK/FIX `:266-269` | position + name |
| 54 | Heat strip cells | colors per 2 min | TS `:271-281` (stand-in model per athlete) | `sim.athletes[].core_c_p95[m]` |
| 55 | Per-athlete peak | "39.0°" | TS `:262-285` | `peak_core_c_p95` (2 decimals) |
| 56 | Strip note | "Heat strip: browser stand-in model…" | HC `:300-304` | label: engine p95, planning only / offline |
| 57 | Drill blocks | "Inside run 15′ · full pads" | plan `:370-408` | plan |
| 58 | Popover: times, chips | "3:44 PM – 3:59 PM · 15 min", Hard, Full pads | plan `:479-494` | plan |
| 59 | Popover: lighter-gear note | "11 athletes wear lighter gear…" | plan `:460,496` | plan `gear_by_athlete` |
| 60 | Popover: hottest in block | "Marcus 39.0°", "1 over 39.0°" | TS series + HC limit `:454-511` | `sim` p95 over the block, `limit_core_c` |
| 61 | Popover: issues | rule text | TS `:461,515-521` | `sim.fhsaa_violations` for that drill |
| 62 | Optimize result list | "What Kelvin changed" | ENG `:319-333` | `OptimizeResult.top_changes_text`, `changes[].detail` (engine text) |
| 63 | Editor: total, blocks, end time, ruler | "113 min · 9 blocks · ends 5:23 PM" | plan CALC `PlanEditor.tsx:141-143,185-193` | plan arithmetic (label) |
| 64 | Editor: new clip defaults | 10 min drill / 4 min break | HC `PlanEditor.tsx:95-97` | label (editor defaults — plan input, not a model output) |
| 65 | Editor clip limits | 1–90 min | HC `PlanEditor.tsx:33-34` | label (editor bounds) |

## Athlete twin (`views/AthleteView.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 66 | Picker chips | jersey numbers + status dot | MOCK + TS `:56-71` | position + `curve.status` |
| 67 | Vitals badge / name / body | "72 Marcus OL · 125 kg · 188 cm" | MOCK/FIX `:99-104` | roster |
| 68 | Estimated core (big) | 37.2 °C | FAKE `:91,131` | `curve.core_c_p50[m]`, "estimate — planning only" |
| 69 | °F + band | "98.9 °F · ±0.08° (p95)" | CALC + TS band `:85,134` | unit conversion of row 68; `p95 − p50` at the next minute |
| 70 | Scrubbed reading | "Forecast · 4:10 PM" | FAKE history/forecast `:345-350` | `curve` p50 at the scrubbed minute (estimate so far = curve in force then) |
| 71 | Status pill | Watch | TS `:138` | `curve.status` |
| 72 | Heart rate | 118 bpm / "No strap paired" | FAKE `:144-151` | row 17 |
| 73 | Forecast peak | "39.0° at 4:44 PM" | CALC/FAKE `:157` | `peak_core_c_p95` (2 decimals) + minute of the p95 max |
| 74 | Model line | "Engine · calibrating…" | FAKE `:163-164` | row 22 |
| 75 | Body figure color / heart beat | thermal colors, beat rate | FAKE `:178` | row 68 / HR |
| 76 | "Heart · strap" callout | label | MOCK `:183-188` | label: "Heart · HR replay" / "Heart · live" |
| 77 | Now card: drill / gear / min left | "Dynamic warmup · Helmet · 7 min left" | plan `:195-198` | plan |
| 78 | Break ring | "27′ to water" (15-min window) | CALC + HC 15 `:306-336` | plan arithmetic; ring fraction from the last break to the next (no invented window) |
| 79 | Forecast title | "Forecast crosses the line" | TS `:210` (`predictedPeakC >= THRESHOLDS.alertC`) | `curve.status == over_limit` |
| 80 | Chart threshold line + label | "39.0° alert line" | HC `TempChart.tsx:72,237-258` | `limit_core_c` |
| 81 | Chart tooltip | "38.43°C ±0.12" | FAKE `TempChart.tsx:125-130,312-316` | curve values |
| 82 | Navigator strip | mini line | FAKE `:262` | curve p50 |
| 83 | Acclimatization "Day 5 of 14" | text + 14 ticks | FIX + HC `:277-289` | roster day; period from `/sources` `nata_ehs.acclimatization_days` |
| 84 | BSA | "BSA 2.49 m²" | TS DuBois in browser `model.ts:13-16`, `:280` | not provided by the engine → "—" |
| 85 | Acclimatization note | "Early days carry the most risk…" (day ≤ 5) | HC threshold 5 `:292-294` | early = NATA phase whose `max_gear` is not full pads (`/sources` `nata_gear_phasing.phases`) |
| 86 | Today's plan card header | "Forecast crosses 39.0° at minute 52" / "9 blocks · 113 min" | ENG when sim, else plan `:489-495` | `sim` athlete `first_cross_min`, `peak_core_c_p95`, `limit_core_c` |
| 87 | Block peaks | "38.4°" per block | ENG p95 (only after a voice plan) `:461-482,527-529` | `sim` p95 over the block (2 decimals) |
| 88 | Block gear / sits out | "Shells", "sits out" | plan `:480-481,523` | plan `gear_by_athlete`, `participants` |
| 89 | Plan source chip | "Default plan" | planStore `:465-472` | label |
| 90 | Card foot | "Peak per block is the engine’s p95…" / "Tap the mic…" | HC `:539-542` | label |
| 91 | Safety line | "Estimated core temperature is for planning…" | HC `constants.ts:43` | label |

## Response (`views/ResponseView.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 92 | Protocol steps | "Call 911 … Hand off to EMS" | HC `:18` | label |
| 93 | "Tub filled, ice on hand · Probe reads 48.9 °F" ✓ | reading + tick | MOCK `:11` | `GET /node/latest` → `reading.tub_temp_c` (null today → "—"); tick only when a reading is under `ksi_cwi.water_temp_c_max` |
| 94 | "Tub within 1 minute of the field · East sideline" ✓ | number + tick | MOCK `:12` | `/sources` `ksi_cwi.tub_within_min_of_field`; not verifiable by HeatTwin → not ticked |
| 95 | "EMS access route clear · Gate 3 unlocked" ✓ | tick | MOCK `:13` | label; not verifiable → not ticked |
| 96 | "AED on the sideline · Checked 3:05 PM" ✓ | time + tick | MOCK `:14` | label; not verifiable → not ticked |
| 97 | "Rectal thermometer · cool 10–15 min" ! | numbers | HC `:15` | `/sources` `ksi_cwi.no_rectal_thermometer_cool_min` |

## Collapse (`views/CollapseMode.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 98 | Header | "Marcus · #72" | MOCK `:161` | roster name · position |
| 99 | Since-collapse clock | 00:02 | wall clock `:89` | wall clock (unchanged) |
| 100 | "Cool within 30:00" + ring | 30 min | HC `:133,199` | `/sources` `nata_ehs.goal_below_f_within_30min` (window from the key) |
| 101 | Step text "cool 10–15 minutes" / spoken "ten to fifteen" | numbers | HC `:45-46` | `/sources` `ksi_cwi.no_rectal_thermometer_cool_min` |
| 102 | Tub water probe | "48.7°F" | MOCK formula `:95,266` | `/node/latest` `reading.tub_temp_c` (null → "—") |
| 103 | "Under 60 °F — cold enough" | threshold | HC `:267-268` | `/sources` `ksi_cwi.water_temp_c_max` (15 °C) |
| 104 | In-the-water timer / bar | mm:ss, 15-min bar | wall clock + HC 15 `:278` | wall clock; bar length from `ksi_cwi.no_rectal_thermometer_cool_min` |
| 105 | "10–15 min without a rectal reading" | numbers | HC `:281` | `/sources` `ksi_cwi.no_rectal_thermometer_cool_min` |
| 106 | Log "Last est. core 37.2 °C (estimate…)" | number | FAKE `:80` | `curve.core_c_p50[m]` (or "—") |
| 107 | Copy for EMS | name #72, tub line | MOCK `:118-123` | roster, `/node/latest` tub reading or "no tub probe reading" |
| 108 | Footer | "Only a rectal temperature…" | HC `:311-313` | label |

## Settings (`views/SettingsView.tsx`, `data/weather.ts`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 109 | Selected location | "Gainesville demo forecast" | HC / Open-Meteo name `:70` | label / Open-Meteo name (place search stays) |
| 110 | "Forecast for 2026-10-04" | date | NWS-B `weather.ts:99-106` | engine `GET /weather?lat&lon&date` (`day[0].time` date) |
| 111 | WBGT forecast after choosing a place | hours | NWS-B `weather.ts:87-127` (browser unit conversion, `rh ?? 50` default) | engine `GET /weather` (`now`, `day[]`, `source`, `labels`) |
| 112 | Source line | "WBGT forecast: National Weather Service…" | HC `:92` | label + engine `/weather` `labels` |

## Sidebar field card (`components/FieldCard.tsx`) and sidebar

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 113 | WBGT value | 88.0 °F | TS interpolation of HC `FORECAST` / NWS-B `:19` | `WeatherHour.wbgt_f` at `m` (the plan's engine weather), or `GET /weather` hour for a chosen location |
| 114 | Source chip | "Forecast" / "NWS forecast" | HC `:16` | `WeatherHour.source`: "NWS forecast" / "NWS fixture" (cached) / "Field node" |
| 115 | Zone bars (5) + active | red on | TS `:11,22-29` | `/sources` zones; active = `fhsaa_zone` |
| 116 | Zone label | "Limit intensity" | TS `constants.ts:25` | `/sources` zone rule text for `fhsaa_zone` |
| 117 | Sidebar alert badge | N | TS/FAKE `App.tsx:38,62` | count of `gates.flag` |
| 118 | "Signed in · Coach Reyes · Head coach · no AT on site" | text | HC `Sidebar.tsx:71-80` | label (unchanged) |

## Demo bar (`components/DemoBar.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 119 | Clock + progress | "3:33 PM" | CALC `:29-31` | plan start + demo minute; live: `/live/state` `minute` |
| 120 | Speeds 1× 4× 10× | controls | HC `:9` | label (playback control) |
| 121 | "Skip to heat" → minute 50 | 50 | HC `:52` | earliest `curve.first_cross_min` (engine), else first `gates.flag` minute |
| 122 | "Replay" tag | label | HC `:59` | label: "Replay" / "Live" / "Offline"; title = replay `source.label` |

## Kelvin voice dock (`components/VoiceDock.tsx`)

| # | Element | Shown | NOW | WILL |
|---|---|---|---|---|
| 123 | Draft plan → engine | auto-applied | GEM → `planStore.confirm` with no confirm step `:56-68` | Confirm sheet (draft drills, transcript, notes) → coach presses Confirm → `/simulate` |
| 124 | Busy caption | "Modeling · 16 athletes" | FIX `:120` | roster length from `/demo/inputs` |
| 125 | Done caption | Gemini change sentence or "9 blocks · 113 min" | GEM / plan `:325-331` | plan arithmetic; Gemini sentences only when they contain no digits |
| 126 | Review / Confirm: transcript | "“10 min warm-up…”" | GEM `:349` | GEM transcript (the coach's own words, shown for checking) |
| 127 | Review / Confirm: drills | "10′ Dynamic warmup Light Helmet" | GEM `:376-391` | GEM draft fields (shown for the coach to confirm) |
| 128 | Review / Confirm: notes | "Needs input …", "Check …" | GEM `:350-357,393-405` | GEM, engine-guarded; sentences with digits are not shown |
| 129 | Result: big count | "1 athletes forecast over 39.0°" | ENG `sim.athletes[].status`, `limit_core_c` `:425,440-446` | same engine fields |
| 130 | Result: near / FHSAA | "0 near the line · 2 FHSAA issues" | ENG `:426,449` | same engine fields |
| 131 | Result: "was N" | was 16 | ENG `p.original` `:427,446` | `OptimizeResult.original` |
| 132 | Result: top changes / Kelvin sentence | top_changes_text | ENG `:466` | `POST /voice/answer?demo=1` (`plan_summary` after Confirm, `optimize` after Optimize, `question` = transcript) → `/guard` + per-answer number check → shown; held (nothing new) if either fails |
| 133 | Result: load / changes | "Kept 73% of training load · 12 changes" | ENG `:469` | `load_kept_pct`, `changes.length` |
| 134 | Result: hottest 3 | "Caleb 41.6° crosses at 46′" | ENG `:428,483-486` | `peak_core_c_p95` (2 decimals), `first_cross_min` |
| 135 | Result: edits list | Gemini change sentences | GEM `:459-465` | GEM, digit-free sentences only |
| 136 | Result label | `sim.labels[0]` | ENG `:437` | same |
| 137 | Result: "What the twin is running · 9 blocks" | count | plan `:515` | plan |
| 138 | Error copy (port 8000) | "…--port 8000…" | HC `:543` | label (port text follows `HEATTWIN_PORT`, default 8010) |

## Summary — count by source

138 rows. Each row is counted once, by the first source code in its NOW column (its primary source) and by the
endpoint in its WILL column ("row N" references count as that row's endpoint).

| NOW (primary source) | Rows |
|---|---|
| HC — hard-coded literals | 32 |
| TS — in-browser model, rules, zone table, thresholds | 25 |
| FAKE — fake live loop, hidden "true" heat, fake HR | 17 |
| MOCK — jersey numbers, strap list, readiness checks, tub formula | 14 |
| CALC — browser arithmetic | 13 |
| ENG — engine result (only after a voice / edited / optimized plan) | 11 |
| plan / planStore — plan structure | 10 |
| FIX — fixture JSON in the browser | 8 |
| GEM — Gemini draft, transcript, notes | 6 |
| NWS-B — browser NWS fetch | 2 |

| WILL | Rows |
|---|---|
| engine `/simulate` · `/optimize` result (or the replay / live curve of the same shape) | 50 |
| label (static copy or provenance label) | 21 |
| plan-structure arithmetic on the engine's plan (minutes, clock times) | 15 |
| engine `/live/replay` · `/live/state` | 12 |
| engine `/sources` (FHSAA zone rules, NATA, KSI) | 12 |
| engine `/demo/inputs` (plan, roster) | 11 |
| Gemini draft fields, shown for the coach to confirm | 5 |
| engine `/weather` | 4 |
| engine `/node/latest` | 3 |
| wall clock | 2 |
| engine `/voice/answer` + `/guard` | 1 |
| not provided by the engine → "—" (BSA) | 1 |
| removed (HR rest/max that drove the fake HR) | 1 |

At boot (before any voice plan) no heat, zone, status or HR number on screen came from the engine. After the rewire
all of them do; the browser keeps only plan-structure arithmetic (minutes, clock times, counts of engine statuses) and
unit conversion (°C → °F) of engine values.

## Addendum: the free voice path (ws-decide, CONTRACTS v1.7)

Rows added after the audit above (not counted in its totals). Every number the dock shows is still the engine's.

| # | Element | NOW | Source | After |
|---|---|---|---|---|
| 139 | Answer sheet: sentence | the engine's `say` | ENG `POST /voice/answer?demo=1` after `POST /voice/decide` | shown and spoken only after `POST /guard` (guard.py AND the embedding assist, `blocked_by` recorded) and the per-answer number check pass; otherwise the fixed "held" message (no number) |
| 140 | Answer sheet: transcript | "“What if we drop the gassers?”" | browser Web Speech API, offline Whisper (`/voice/transcribe`) or typed | the coach's own words, shown so a mishearing is visible |
| 141 | Answer sheet: provenance line | "forecast is fixture · synthetic roster" | ENG `labels` of the answer (short synthetic / fixture ones) | same |
| 142 | "Did you mean…?" options | two buttons | ENG `did_you_mean` (fixed intent labels; athlete and drill names from the roster / plan sent) | the decision layer abstained; nothing runs until one is tapped |
| 143 | Confirm label for a locally parsed plan | "parsed locally (no AI service) — coach must confirm" | ENG `POST /plan/parse_local` `labels[0]` | same; assumptions (gear, start time, break length, intensity) appear as "Check" notes, digit-free ones only |
