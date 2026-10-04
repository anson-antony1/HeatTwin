# CONTRACTS.md — frozen data shapes (v1.6)

Freeze at M0. Additive changes only after that.
**v1.1 (additive, Oct 3):** fields marked `// v1.1` are new and optional; every v1 field keeps its meaning.
**v1.2 (additive, Oct 3 night):** `// v1.2` — Drill.drill_type, OptimizeResult.top_changes/top_changes_text, voice-tool endpoints. Units are in field names. Times are ISO 8601 with offset; durations are in minutes.
**v1.6 (additive, polish):** `POST /live/start` optional `live_demo` (athlete → drill their HR is read against) and response `live_demo`; `LiveState.athletes[id].live_demo`; `WeatherHour.time_shifted_min` (a live session on the pinned forecast shifted to now, labelled "forecast snapshot (time-shifted)"); `GET /validation/hr_recording`; `/live/replay` defaults to the synthetic file; guard rule "suspected/possible <heat illness>" with one exception scoped to the Collapse 911 script.
**v1.5 (additive, final-ui):** `GET /live/state` (the web polls the live HR session), `LiveReplay.source.{date, device, label}`.
**v1.4 (additive, Oct 3 night):** `?source=node` (node demo scenario weather; never with ?demo=1), `OptimizeResult.fewest_changes` (minimum compliant edit), `GET /demo/comparison` (same plan, three weather inputs), `/voice/answer` optional `question`, `first_cross_min: number | null`. GET /weather is implemented (engine/weather_routes.py, display only).
**v1.3 (additive, Oct 3 evening, audit-fixes):** `// v1.3` — /demo/inputs, POST /athlete_status and /field_conditions (act on the plan on screen), /live/replay, /node + /node/latest implemented, /plan/parse* (Gemini plan entry, already shipped), voice Q&A: /voice/intent → /voice/answer → /voice/tts. GET /weather is still not implemented (the engine reads the cached NWS fixture; live NWS only with HEATTWIN_WEATHER=live, never with ?demo=1).

## Athlete
```ts
type Athlete = {
  id: string;
  name: string;               // demo roster uses fictional names
  position?: string;          // "OL", "WR", ...
  height_m: number;
  mass_kg: number;
  age_yr: number;
  sex: "male" | "female";
  body_fat_pct?: number;
  hr_rest_bpm?: number;       // from baseline sessions, if known
  hr_max_bpm?: number;        // default from age formula in constants.yaml
  acclimatization_day: number; // 1 = first day of heat exposure this preseason
  days_since_last_heat_session?: number;
  flags?: string[];           // e.g. "recent_illness", "prior_ehi" — self/AT reported, never inferred
  calib?: AthleteCalibration; // filled by calibrate.py
  gear_limit?: GearLevel;     // v1.1: AT-set gear cap. NATA 2009 phasing from acclimatization_day always applies
                              //       (days 1–2 helmet, 3–5 helmet+shoulder pads, 6+ full); this can only tighten it
  vo2max_ml_kg_min?: number;  // v1.1: if measured; default by position group (Boden 2022: linemen 32.8, others 41.8)
};

type AthleteCalibration = {
  met_scale: number;          // multiplies drill MET estimate
  met_scale_sd: number;
  thermo_scale: number;       // scales sweating/vasomotor effectiveness
  thermo_scale_sd: number;
  n_sessions: number;
  updated_at: string;
};
```

## Drill and PracticePlan
```ts
type GearLevel = "none" | "helmet" | "helmet_shoulder_pads" | "full_pads";

type Drill = {
  id: string;
  name: string;               // "Individual period"
  duration_min: number;
  intensity: "rest" | "light" | "moderate" | "hard" | "max";
  met_override?: number;      // if coach/AT supplies one
  gear: GearLevel;
  shade: boolean;             // true for breaks under tent
  is_break: boolean;
  priority: 1 | 2 | 3;        // 1 = must keep, 3 = first to trim
  movable: boolean;           // can the optimizer reorder it?
  participants?: string[];    // athlete ids; default = all
  gear_by_athlete?: Record<string, GearLevel>; // v1.1: per-athlete gear in this drill (overrides `gear` for those ids)
  drill_type?: "warmup" | "individual" | "team" | "special_teams" | "conditioning" | "cooldown" | "break"; // v1.2 (else inferred from name/intensity)
};

type PracticePlan = {
  id: string;
  site: { name: string; lat: number; lon: number; surface: "grass" | "turf" };
  start: string;              // ISO time
  drills: Drill[];
};
```

## Weather
```ts
type WeatherHour = {
  time: string;
  air_temp_c: number;
  rh_pct: number;
  wind_m_s: number;
  cloud_cover_pct: number;
  solar_w_m2?: number;        // computed if absent
  wbgt_f: number;             // computed by wbgt.py
  fhsaa_zone: 1 | 2 | 3 | 4 | 5;
  source: "nws_forecast" | "field_node" | "assimilated" | "fixture";
  time_shifted_min?: number;  // v1.6: live session on the pinned forecast shifted by this many minutes to now
};
```

## Field node reading (ESP32 → engine POST /node)
```json
{ "node_id": "node-1", "ts": "2026-10-03T15:02:00-04:00",
  "air_temp_c": 30.1, "rh_pct": 62.0, "globe_temp_c": 41.3,
  "tub_temp_c": 9.8, "wind_m_s": null, "battery_v": 4.1 }
```

## Live HR (web → engine POST /hr)
```json
{ "athlete_id": "a07", "ts": "...", "hr_bpm": 168, "device": "Polar H10", "replay": false }
```

## SimulationResult (engine → web)
```ts
type SimulationResult = {
  plan_id: string;
  step_min: number;                     // e.g. 1
  times: string[];                      // length T
  weather: WeatherHour[];
  athletes: {
    id: string;
    name?: string;                      // v1.1
    core_c_p50: number[];               // length T
    core_c_p95: number[];
    first_cross_min?: number;           // first minute p95 >= limit
    peak_core_c_p95: number;
    status: "below_limit" | "near_limit" | "over_limit"; // never "safe"
  }[];
  limit_core_c: number;                 // from constants.yaml
  fhsaa_violations: { drill_id: string; rule: string; detail: string }[];  // v1.1: rule may be "nata_gear_phasing"
  training_load_met_min: number;
  model: { name: "twonode-v1"; params_ref: string;
           clothing_mode?: "conservative" | "iso7933_dynamic" | "gagge_static" };  // v1.1
  settings?: AtSettings;                // v1.1: the AT-owned settings this run used
  labels: string[];                     // e.g. ["estimate — planning only", "forecast is fixture",
                                        //       "AT-owned settings — planning limit 39.0 °C (default; …)"]
};

// v1.1: settings an athletic trainer owns (GET /settings lists defaults, sources, allowed values)
type AtSettings = {
  planning_limit_core_c: number;        // default 39.0 (NIOSH 2016); alternatives 38.0, 38.5
  near_limit_margin_c: number;          // default 0.3
  clothing_mode: "conservative" | "iso7933_dynamic" | "gagge_static";  // default conservative
  non_participant_shade: boolean;       // rotated-out athletes rest in shade (default true)
  enforce_nata_gear_phasing: boolean;   // default true
  max_added_minutes: number;            // optimizer may lengthen practice by at most this (default 20)
  p1_min_kept_fraction: number;         // default 0.9
  priority_weights: Record<"1" | "2" | "3", number>;   // default 3 / 2 / 1
  gear_floor_by_intensity: Record<string, GearLevel>;  // default { hard: "helmet", max: "none" }
};
```

## OptimizeResult
```ts
type OptimizeResult = {
  original: SimulationResult;
  optimized: SimulationResult;
  plan: PracticePlan;                   // new plan
  changes: { kind: "reorder" | "insert_break" | "gear_change" | "trim" | "shade"; drill_id: string; detail: string;
             move?: "reorder" | "insert_break" | "lengthen_break" | "split" | "platoon" | "rotate_out" | "trim"
                  | "remove" | "gear_down" | "gear_per_athlete" | "shade" }[];   // v1.1: finer move type
  load_kept_pct: number;
  feasible: boolean;
  search: { iterations: number; seconds: number; method: string;
            // v1.1 (all optional):
            evaluations?: number; cache_hits?: number; beam_iterations?: number; sa_iterations?: number;
            sa_best_iteration?: number; stopped_by?: "iterations" | "time_budget"; seed?: number;
            budget_s?: number; demo?: boolean; weighted_load_kept_pct?: number };
  infeasible_reasons?: string[];        // v1.1: why feasible=false (least-bad plan still returned in `plan`)
  top_changes?: { kind: string; move?: string; drill_id: string; detail: string; heat_reduction_c: number }[]; // v1.2: top 3 by heat reduction (leave-one-out, team-mean peak p95)
  top_changes_text?: string;            // v1.2: guarded sentence for the UI / voice agent
  settings?: AtSettings;                // v1.1
  labels?: string[];                    // v1.1: "estimate — planning only", settings, demo mode, least-bad notice
};
```

## Collapse event log
```ts
type CollapseLog = {
  athlete_id: string;
  collapse_at: string;
  events: { t: string; kind: "911_called" | "immersed" | "stirring" | "tub_temp" | "removed" | "ems_arrived" | "note"; value?: number | string }[];
  tub_temp_c_series: [string, number][];
  hr_series: [string, number][];
  labels: string[];                     // "not a diagnosis", "times entered by coach"
};
```

## API
| Method | Path | Body → Response |
|---|---|---|
| GET | `/weather?lat&lon` | → `WeatherHour[]` |
| POST | `/simulate` | `{plan, roster}` → `SimulationResult` · v1.1 optional body fields: `weather`, `step_min`, `n_ensemble`, `seed`, `settings` (AT overrides); `?demo=1` fixes the seed. Missing plan/roster/weather fall back to labelled fixtures |
| POST | `/optimize` | `{plan, roster, budget_s?}` → `OptimizeResult` · v1.1: same optional fields; `?demo=1` = fixed seed + fixed iteration cap instead of a time budget (reproducible) |
| GET | `/settings` | v1.1 → `{owner: "athletic trainer", settings: [{key, value, default, status, source, description, …}]}` |
| GET | `/health` | v1.1 → `{ok, model, fhsaa: "stub" \| "ws1"}` |
| POST | `/hr` | live HR → `{athlete_id, calib, reforecast: SimulationResult}` · v1.1 adds `gates: {crossing, persistent, coverage_ok, coverage_fraction, n_updates, flag, held_by[], message}`, `updated`, `replay`, `labels` |
| POST | `/live/start` | v1.1 `{plan?, roster?, weather?, settings?, seed?}` → `{ok, plan_id, athletes}` — starts/reset the live session /hr uses (defaults to fixtures). v1.6: `live_demo?: Record<athleteId, drill id or name word>` (e.g. `{"a07": "conditioning"}`): that athlete's HR is read against the drill's intensity and gear instead of the plan drill at the clock; the re-forecast still runs the plan as written; labels gain `"live demo · <word>"`; response `live_demo: Record<athleteId, {drill_id, drill, intensity}>`; 422 for an unknown athlete or no matching drill. v1.6 weather with `start_now` and no `weather`: the node demo scenario if running; else live NWS (label "live NWS forecast", not cached to disk); else the pinned forecast shifted so its plan start lands on now (label "forecast snapshot (time-shifted)", `WeatherHour.time_shifted_min`). `?demo=1` is never affected |
| POST | `/node` | node reading → `{ok}` |
| GET | `/node/latest` | → last reading + assimilated `WeatherHour` |
| GET | `/sources` | → constants.yaml as JSON with status |
| POST | `/what_if` | v1.2 `{change: {drill_id, gear?\|duration_min?\|shade?\|intensity?\|move_to?\|remove?} \| {add_break_after, minutes}, plan?, roster?, settings?}` → `{before, after, delta_team_mean_p95_c, say, labels}` (summaries: athletes, over_limit, near_limit, max_p95_c, team_mean_p95_c, first_cross_min, limit_c, fhsaa_violations, practice_min) |
| GET | `/athlete_status?athlete_id=` | v1.2 id or name → `{id, name, position, acclimatization_day, gear_limit, peak_p50_c, peak_p95_c, status, first_cross_min, limit_c, say, labels}` |
| GET | `/field_conditions` | v1.2 → `{hours: [{time, wbgt_f, fhsaa_zone, air_temp_c, rh_pct, source}], sources, say, labels}` |
| POST | `/guard` | `{text}` → `{ok, redacted_text, hits[]}`. Source is always "api": the scoped Collapse-911 exception (constants.guard_exceptions) cannot be claimed over HTTP |
| GET | `/health` | v1.3 adds `weather: "fixture" \| "live"` |
| GET | `/demo/inputs` | v1.3 → `{plan: PracticePlan, roster: Athlete[], weather: WeatherHour[], labels, synthetic: {plan, roster, weather}}` — exactly what `/simulate?demo=1` with no body simulates. The web shows this plan/roster instead of its own copies |
| POST | `/athlete_status` | v1.3 `{athlete: id or name, plan?, roster?, settings?}` (`?demo=1`) → same as the GET, on the plan sent. `labels` now carry the fixture labels too |
| POST | `/field_conditions` | v1.3 `{plan?, roster?, settings?}` → same as the GET, for the plan's window |
| POST | `/live/replay` | v1.3 `{plan?, roster?, settings?, file?}` (`?demo=1`) → `LiveReplay` (below). Default `fixtures/hr_a07_synthetic.csv` (labelled synthetic); v1.6: a real `fixtures/hr_<date>.csv` is replayed only when named in `file` (labelled with its date and device). Deterministic; cached |
| POST | `/node` | v1.3 implemented: node reading (`node_bridge.node_payload`) → `{ok, hour: WeatherHour (source "field_node")}` — kept in memory for this engine run |
| GET | `/node/latest` | v1.3 → `NodeLatest` (below). Newest `data/node_<date>.csv` or the last POST /node; else `{reading: null, labels: ["no field recording yet"]}` — never placeholder numbers |
| POST | `/plan/parse` · `/plan/parse_audio` · GET `/plan/llm_status` | v1.3 (shipped on llm-bridge) Gemini plan entry → `PlanDraft {plan, transcript, assumptions[], unclear[], total_min, needs_confirmation: true, labels, model}`. Coach must confirm before /simulate |
| POST | `/voice/intent` | v1.3 `{text? \| audio_b64 + mime_type, plan?, roster?}` → `VoiceIntent` (below). Gemini returns only `{transcript, intent, slots}` against a JSON schema; the engine validates it and resolves names against the plan. 503 when no GEMINI_API_KEY (the web then routes typed text locally) |
| POST | `/voice/answer` | v1.3 `{intent, slots, plan?, roster?, settings?}` (`?demo=1`) → `VoiceAnswer` (below). The engine runs the tool and writes the sentence; `say` already passed engine/guard.py |
| POST | `/voice/tts` | v1.3 `{text}` → `audio/mpeg`. Re-guards `text` (422 on a hit); 503 when no ELEVENLABS_API_KEY or the network is down (the web then uses speechSynthesis). The key stays on the engine |

```ts
// v1.3
type LiveReplay = {
  source: { file: string; synthetic: boolean; athletes: string[]; n_readings: number; first_ts: string; last_ts: string;
            aligned_to_plan_start: boolean };   // a real recording's clock is shifted so its first reading = plan start
  plan_forecast: SimulationResult;               // before any HR (the prior)
  frames: {                                      // one per calibration update (every update_interval_s)
    minute: number;                              // minutes since plan start
    athlete_id: string;
    hr_bpm: number;                              // last reading used
    calib: { met_scale: number; met_scale_sd: number };
    gates: { crossing: boolean; persistent: boolean; coverage_ok: boolean; coverage_fraction: number; n_updates: number;
             flag: boolean; held_by: string[]; message: string };
    athlete: { core_c_p50: number[]; core_c_p95: number[]; peak_core_c_p95: number; status: string; first_cross_min: number | null };
  }[];
  hr_series: Record<string, [number, number][]>; // athlete_id → [minute, bpm], one point per 10 s
  labels: string[];                              // "replay", "synthetic HR (not a real athlete)" when synthetic, + plan labels
};

type NodeLatest = {
  reading: null | { ts: string; globe_c: number; air_c: number; rh_pct: number; air_source: string; node_wbgt_f: number;
                    forecast_wbgt_f: number; field_minus_forecast_f: number; fhsaa_zone: number; globe_calibrated: boolean;
                    tub_temp_c: number | null };      // null until a tub probe is wired (node_bridge sends null today)
  series: { ts: string; node_wbgt_f: number; forecast_wbgt_f: number }[];   // the recording, one point per minute
  file: string | null;
  labels: string[];                              // "no field recording yet" | "field node recording", "globe thermistor uncalibrated", …
};

type VoiceIntentName = "plan_summary" | "optimize" | "what_if" | "athlete_status" | "field_conditions" | "unknown";
type VoiceIntent = {
  transcript: string;
  intent: VoiceIntentName;
  slots: { athlete_id?: string; drill_id?: string; change?: "gear" | "duration" | "shade" | "intensity" | "remove" | "add_break" | "move";
           gear?: GearLevel; duration_min?: number; intensity?: Intensity; shade?: boolean; move_to?: number;
           preset?: "max_load" | "fewest_changes" };
  unresolved: string[];                          // names the engine could not match on the plan (asked back, not guessed)
  labels: string[];                              // "intent parsed by AI — numbers come from the engine"
  model: string;
};

type VoiceAnswer = {
  intent: VoiceIntentName;
  say: string;                                   // engine-written, guarded; the ONLY text shown/spoken
  numbers: string[];                             // every number token that appears in `say`, as written (per-answer ledger)
  data: Record<string, unknown>;                 // the tool result the numbers came from
  labels: string[];
};
```

```ts
// v1.4
type FewestChanges = {                 // on OptimizeResult when preset=fewest_changes
  cap: number;                         // the preset's change cap (constants.optimizer_presets)
  min_compliant_changes: number | null;// smallest cap (searched upward from `cap`) that gives a plan meeting every
                                       // FHSAA/NATA rule with every athlete under the line; null if none up to max_load's count
  searched_caps: number[];
  fell_back: boolean;                  // true only if no capped plan qualified and the max_load plan is shown
};
// When min_compliant_changes > cap the result IS the plan found at that cap; the UI says
// "needs at least N changes" (never "fell back").

type DemoComparison = {                // GET /demo/comparison — a stored snapshot (scripts/demo_numbers.py), no network
  plan_id: string;
  rows: { key: "saved_forecast" | "live_nws_wbgt" | "live_liljegren"; input: string; fetched_at: string | null;
          wbgt_f_by_hour: [string, number][]; peak_zone: number; over_before: number; over_after: number;
          load_kept_pct: number; changes: number; feasible: boolean }[];
  headline: "saved_forecast";
  labels: string[];
};
```
| POST | `/voice/answer` | v1.4 optional `question` (the coach's words): when it asks whether someone is "safe/fine/OK/cleared", `say` starts with the boundary sentence (no clearance is given) |
| GET | `/demo/comparison` | v1.4 → `DemoComparison` (snapshot; 404 until scripts/demo_numbers.py has run) |
| GET | `/live/state` | v1.5 → `LiveState` (poll every few seconds). Start with `POST /live/start {"start_now": true}`; readings arrive from `engine/hr_bridge.py` (`POST /hr`) |
| GET | `/validation/hr_recording` | v1.6 → `validation/results.json["helio_recording"]`: the real strap recording as calibration evidence `{file, device, date, athlete_ids, n_readings, duration_min, hr_bpm: {min, mean, max}, per_minute_mean_hr_bpm, calibration: {mapped_drill, n_updates, prior_met_scale(_sd), final_met_scale(_sd), sd_reduction_pct, last5_met_scale_range, trajectory} \| null, labels, synthetic: false, replay: true}`; 404 when none |

```ts
// v1.5
type LiveState = {
  active: boolean;                 // a live session exists (POST /live/start)
  receiving: boolean;              // some athlete's strap reading is newer than constants.live_hr.stale_after_s
  plan_id?: string; plan_start?: string; now?: string;
  minute?: number;                 // minutes since plan start (wall clock)
  athletes: Record<string, {       // athletes with readings
    hr_bpm: number; ts: string; device: string;   // device display name, e.g. "Amazfit Helio Strap"
    replay: boolean; age_s: number; receiving: boolean; minute: number;
    calib: { met_scale: number; met_scale_sd: number } | null;
    gates: LiveReplay["frames"][number]["gates"] | null;
    athlete: { core_c_p50: number[]; core_c_p95: number[]; peak_core_c_p95: number; status: string; first_cross_min: number | null } | null;
    live_demo?: { drill_id: string; drill: string; intensity: string };   // v1.6: HR read against this drill
  }>;
  reforecast?: SimulationResult;   // whole roster, latest calibration (plan forecast for athletes without HR)
  labels: string[];                // "live · Amazfit Helio Strap" (or "replay (hr_bridge) · …") + plan labels;
                                   // v1.6: "live demo · conditioning" first with a live-demo mapping
};
// LiveReplay.source (v1.5 additive): date: string | null; device: string | null;
//   label: "replay · <date> · <device>" | "replay · synthetic HR file (not a real athlete)"
```
