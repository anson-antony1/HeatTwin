# CONTRACTS.md — frozen data shapes (v1)

Freeze at M0. Additive changes only after that. Units are in field names. Times are ISO 8601 with offset; durations are in minutes.

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
    core_c_p50: number[];               // length T
    core_c_p95: number[];
    first_cross_min?: number;           // first minute p95 >= limit
    peak_core_c_p95: number;
    status: "below_limit" | "near_limit" | "over_limit"; // never "safe"
  }[];
  limit_core_c: number;                 // from constants.yaml
  fhsaa_violations: { drill_id: string; rule: string; detail: string }[];
  training_load_met_min: number;
  model: { name: "twonode-v1"; params_ref: string };
  labels: string[];                     // e.g. ["estimate — planning only", "forecast is fixture"]
};
```

## OptimizeResult
```ts
type OptimizeResult = {
  original: SimulationResult;
  optimized: SimulationResult;
  plan: PracticePlan;                   // new plan
  changes: { kind: "reorder" | "insert_break" | "gear_change" | "trim" | "shade"; drill_id: string; detail: string }[];
  load_kept_pct: number;
  feasible: boolean;
  search: { iterations: number; seconds: number; method: string };
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
| POST | `/simulate` | `{plan, roster}` → `SimulationResult` |
| POST | `/optimize` | `{plan, roster, budget_s?}` → `OptimizeResult` |
| POST | `/hr` | live HR → `{athlete_id, calib, reforecast: SimulationResult}` |
| POST | `/node` | node reading → `{ok}` |
| GET | `/node/latest` | → last reading + assimilated `WeatherHour` |
| GET | `/sources` | → constants.yaml as JSON with status |
| POST | `/guard` | `{text}` → `{ok, redacted_text, hits[]}` |
