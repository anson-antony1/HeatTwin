import type { LiveReplay, LiveState, ReplayFrame, SimAthlete, SimulationResult, WeatherHour } from '../engineApi'
import type { PracticePlan } from '../llmPlan'

// Small engine-shaped objects for the data-layer tests (CONTRACTS.md shapes; values are test inputs, not physiology).

export const PLAN: PracticePlan = {
  id: 'plan-test',
  site: { name: 'Test field', lat: 29.65, lon: -82.32, surface: 'grass' },
  start: '2026-10-04T15:30:00-04:00',
  drills: [
    { id: 'd1', name: 'Warmup', duration_min: 4, intensity: 'light', gear: 'helmet', shade: false, is_break: false, priority: 1, movable: false },
    { id: 'b1', name: 'Water break', duration_min: 2, intensity: 'rest', gear: 'helmet', shade: true, is_break: true, priority: 1, movable: true },
    { id: 'd2', name: 'Team period', duration_min: 4, intensity: 'hard', gear: 'full_pads', shade: false, is_break: false, priority: 1, movable: true },
  ],
}

export function athlete(id: string, p50: number[], p95: number[], status: SimAthlete['status'], firstCross: number | null = null): SimAthlete {
  return { id, name: `${id} (fictional)`, core_c_p50: p50, core_c_p95: p95, peak_core_c_p95: Math.max(...p95), status, first_cross_min: firstCross }
}

export const WEATHER: WeatherHour[] = [
  { time: '2026-10-04T15:00:00-04:00', air_temp_c: 31, rh_pct: 60, wind_m_s: 2, cloud_cover_pct: 20, wbgt_f: 86, fhsaa_zone: 2, source: 'fixture' },
  { time: '2026-10-04T16:00:00-04:00', air_temp_c: 30, rh_pct: 62, wind_m_s: 2, cloud_cover_pct: 20, wbgt_f: 83, fhsaa_zone: 2, source: 'fixture' },
]

/** 10-minute plan, step 1: outputs at the end of minutes 1…10. */
export function sim(over: Partial<SimulationResult> = {}): SimulationResult {
  return {
    plan_id: PLAN.id,
    step_min: 1,
    times: Array.from({ length: 10 }, (_, k) => `t${k + 1}`),
    weather: WEATHER,
    athletes: [
      athlete('a01', [37.0, 37.1, 37.2, 37.3, 37.4, 37.5, 37.6, 37.7, 37.8, 37.9], [37.1, 37.2, 37.3, 37.5, 37.7, 38.0, 38.4, 38.7, 38.98, 38.9], 'near_limit'),
      athlete('a02', [37.0, 37.2, 37.4, 37.6, 37.8, 38.0, 38.2, 38.4, 38.6, 38.8], [37.2, 37.5, 37.8, 38.1, 38.4, 38.7, 39.0, 39.3, 39.6, 39.9], 'over_limit', 7),
    ],
    limit_core_c: 39.0,
    fhsaa_violations: [{ drill_id: 'plan', rule: 'zone2_breaks_per_hour', detail: 'Hour 2026-10-04T15:00:00-04:00: 1 break scheduled, 2 required' }],
    training_load_met_min: 100,
    labels: ['estimate — planning only', 'forecast is fixture'],
    ...over,
  }
}

export function frame(minute: number, athleteId: string, p50: number[], p95: number[], flag: boolean, coverage = true): ReplayFrame {
  return {
    minute,
    athlete_id: athleteId,
    hr_bpm: 150,
    calib: { met_scale: 1.1, met_scale_sd: 0.1 },
    gates: { crossing: flag, persistent: flag, coverage_ok: coverage, coverage_fraction: coverage ? 1 : 0.2, n_updates: minute, flag, held_by: flag ? [] : ['crossing'], message: flag ? 're-forecast shows crossing' : 'no crossing in re-forecast' },
    athlete: { core_c_p50: p50, core_c_p95: p95, peak_core_c_p95: Math.max(...p95), status: flag ? 'over_limit' : 'near_limit', first_cross_min: flag ? 6 : null },
  }
}

export function replay(): LiveReplay {
  const flat = (v: number) => Array.from({ length: 10 }, () => v)
  return {
    source: { file: 'fixtures/hr_test.csv', synthetic: true, athletes: ['a01'], n_readings: 60, first_ts: '', last_ts: '', aligned_to_plan_start: true, label: 'replay · synthetic HR file (not a real athlete)' },
    plan_forecast: sim(),
    frames: [frame(2, 'a01', flat(37.5), flat(38.5), false), frame(5, 'a01', flat(38.0), flat(39.2), true)],
    hr_series: { a01: [[0, 90], [1, 120], [2, 130], [3, 140], [4, 150], [5, 160]] },
    labels: ['replay', 'synthetic HR (not a real athlete)'],
  }
}

export function liveState(over: Partial<LiveState> = {}): LiveState {
  const flat = (v: number) => Array.from({ length: 10 }, () => v)
  return {
    active: true,
    receiving: true,
    plan_id: PLAN.id,
    plan_start: '2026-10-04T15:30:00-04:00',
    now: '2026-10-04T15:34:00-04:00',
    minute: 4,
    athletes: {
      a02: {
        hr_bpm: 171,
        ts: '2026-10-04T15:34:00-04:00',
        device: 'Amazfit Helio Strap',
        replay: false,
        age_s: 1,
        receiving: true,
        minute: 4,
        calib: { met_scale: 1.2, met_scale_sd: 0.1 },
        gates: { crossing: true, persistent: true, coverage_ok: true, coverage_fraction: 1, n_updates: 4, flag: true, held_by: [], message: 're-forecast shows crossing' },
        athlete: { core_c_p50: flat(38.2), core_c_p95: flat(39.4), peak_core_c_p95: 39.4, status: 'over_limit', first_cross_min: 3 },
      },
    },
    reforecast: sim(),
    labels: ['live · Amazfit Helio Strap', 'synthetic plan (fixture)'],
    ...over,
  }
}
