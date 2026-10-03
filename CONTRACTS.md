# CONTRACTS.md — frozen data shapes (v1.1)

Freeze at M0. Additive changes only after that.
**v1.1 (additive, Oct 3):** fields marked `// v1.1` are new and optional; every v1 field keeps its meaning. Units are in field names. Times are ISO 8601 with offset; durations are in minutes.

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
| POST | `/live/start` | v1.1 `{plan?, roster?, weather?, settings?, seed?}` → `{ok, plan_id, athletes}` — starts/reset the live session /hr uses (defaults to fixtures) |
| POST | `/node` | node reading → `{ok}` |
| GET | `/node/latest` | → last reading + assimilated `WeatherHour` |
| GET | `/sources` | → constants.yaml as JSON with status |
| POST | `/guard` | `{text}` → `{ok, redacted_text, hits[]}` |
