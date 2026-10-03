import type { ContractGear, PracticePlan } from './llmPlan'

// Typed client for the HeatTwin engine (CONTRACTS.md v1.3). Every number the
// web shows comes from one of these responses; the in-browser stand-ins under
// src/offline/ are used only when the engine can't be reached, and are badged.
// Only the fields the UI reads are typed; the engine may send more.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

export type AthleteStatus = 'below_limit' | 'near_limit' | 'over_limit'
export type FhsaaZone = 1 | 2 | 3 | 4 | 5

export interface WeatherHour {
  time: string
  air_temp_c: number
  rh_pct: number
  wind_m_s: number
  cloud_cover_pct: number
  solar_w_m2?: number
  wbgt_f: number
  fhsaa_zone: FhsaaZone
  source: 'nws_forecast' | 'field_node' | 'assimilated' | 'fixture'
}

export interface AtSettings {
  planning_limit_core_c: number
  near_limit_margin_c: number
  clothing_mode: string
  [key: string]: unknown
}

export interface SimAthlete {
  id: string
  name?: string
  core_c_p50: number[]
  core_c_p95: number[]
  first_cross_min?: number | null
  peak_core_c_p95: number
  status: AthleteStatus
}

export interface FhsaaViolation {
  drill_id: string
  rule: string
  detail: string
}

export interface SimulationResult {
  plan_id: string
  /** Output spacing. `times[k]` = plan start + (k + 1) · step_min. */
  step_min: number
  times: string[]
  weather: WeatherHour[]
  athletes: SimAthlete[]
  limit_core_c: number
  fhsaa_violations: FhsaaViolation[]
  training_load_met_min: number
  settings?: AtSettings
  labels: string[]
}

export interface PlanChange {
  kind: string
  move?: string
  drill_id: string
  detail: string
}

export interface OptimizeResult {
  original: SimulationResult
  optimized: SimulationResult
  plan: PracticePlan
  changes: PlanChange[]
  load_kept_pct: number
  feasible: boolean
  infeasible_reasons?: string[]
  top_changes_text?: string
  labels?: string[]
}

/** CONTRACTS.md Athlete (the engine's roster). */
export interface RosterAthlete {
  id: string
  name: string
  position?: string
  height_m: number
  mass_kg: number
  age_yr: number
  sex: 'male' | 'female'
  hr_rest_bpm?: number
  hr_max_bpm?: number
  acclimatization_day: number
  gear_limit?: ContractGear
}

/** v1.3 GET /demo/inputs — exactly what /simulate?demo=1 simulates with no body. */
export interface DemoInputs {
  plan: PracticePlan
  roster: RosterAthlete[]
  weather: WeatherHour[]
  labels: string[]
  synthetic: { plan: boolean; roster: boolean; weather: boolean }
}

export interface ReplayGates {
  crossing: boolean
  persistent: boolean
  coverage_ok: boolean
  coverage_fraction: number
  n_updates: number
  flag: boolean
  held_by: string[]
  message: string
}

export interface ReplayFrame {
  /** Minutes since plan start. */
  minute: number
  athlete_id: string
  hr_bpm: number
  calib: { met_scale: number; met_scale_sd: number }
  gates: ReplayGates
  athlete: {
    core_c_p50: number[]
    core_c_p95: number[]
    peak_core_c_p95: number
    status: AthleteStatus
    first_cross_min: number | null
  }
}

/** v1.3 POST /live/replay — a recorded (or the labelled synthetic) HR file run through live calibration. */
export interface LiveReplay {
  source: {
    file: string
    synthetic: boolean
    athletes: string[]
    n_readings: number
    first_ts: string
    last_ts: string
    aligned_to_plan_start: boolean
  }
  plan_forecast: SimulationResult
  frames: ReplayFrame[]
  /** athlete_id → [minute, bpm]. */
  hr_series: Record<string, [number, number][]>
  labels: string[]
}

/** v1.3 GET /node/latest. */
export interface NodeLatest {
  reading: null | {
    ts: string
    globe_c: number
    air_c: number
    rh_pct: number
    air_source: string
    node_wbgt_f: number
    forecast_wbgt_f: number
    field_minus_forecast_f: number
    fhsaa_zone: number
    globe_calibrated: boolean
  }
  series: { ts: string; node_wbgt_f: number; forecast_wbgt_f: number }[]
  file: string | null
  labels: string[]
}

export interface SettingEntry {
  key: string
  value: unknown
  default: unknown
  status?: string
  source?: string
  description?: string
}

export interface SettingsResponse {
  owner: string
  settings: SettingEntry[]
}

/** One row of /sources → fhsaa_wbgt_zones.zones (FHSAA Policy 41 §41.8.3). */
export interface FhsaaZoneRule {
  zone: number
  wbgt_f_max: number
  activity: string
  breaks_per_hour: number | null
  break_min: number | null
  max_duration_min: number | null
  gear: string
}

export interface NataPhase {
  first_day: number
  last_day: number
  max_gear: ContractGear
}

/** GET /sources is constants.yaml as JSON; only the blocks the UI reads are typed. */
export interface Sources {
  fhsaa_wbgt_zones?: { status?: string; source?: string; zones?: FhsaaZoneRule[] }
  nata_gear_phasing?: { status?: string; source?: string; phases?: NataPhase[] }
  nata_ehs?: { status?: string; source?: string; acclimatization_days?: number[] }
  [block: string]: unknown
}

export class EngineError extends Error {
  status: number
  /** True when the engine could not be reached at all (network down, proxy can't connect). */
  unreachable: boolean
  constructor(status: number, message: string, unreachable = false) {
    super(message)
    this.status = status
    this.unreachable = unreachable
  }
}

/** The engine is down (not merely refusing a request): the views fall back to the badged stand-in. */
export function isUnreachable(e: unknown): boolean {
  return e instanceof EngineError && e.unreachable
}

const TIMEOUT_MS = 60_000

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    r = await fetch(`${ENGINE}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if ((e as Error).name === 'TimeoutError') throw new EngineError(0, 'The engine took too long to answer.')
    throw new EngineError(0, `Can't reach the engine (${ENGINE}). Is it running?`, true)
  }
  if (!r.ok) {
    // FastAPI always answers errors as JSON {detail}. A non-JSON 5xx comes from the dev proxy
    // when nothing is listening behind it — i.e. the engine is down.
    let msg = r.statusText
    let json = false
    try {
      const j = await r.json()
      json = true
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* keep statusText */
    }
    const down = !json && r.status >= 500
    throw new EngineError(r.status, down ? `Can't reach the engine (${ENGINE}). Is it running?` : msg, down)
  }
  return r.json() as Promise<T>
}

/** v1.3: the plan, roster and weather the demo simulates (the web shows these, not its own copies). */
export function getDemoInputs(signal?: AbortSignal) {
  return request<DemoInputs>('GET', '/demo/inputs', undefined, signal)
}

/** Roster and weather fall back to the engine's labelled fixtures. */
export function simulatePlan(plan: PracticePlan, signal?: AbortSignal) {
  return request<SimulationResult>('POST', '/simulate?demo=1', { plan }, signal)
}

export function optimizePlan(plan: PracticePlan, signal?: AbortSignal, preset: 'max_load' | 'fewest_changes' = 'max_load') {
  return request<OptimizeResult>('POST', `/optimize?demo=1&preset=${preset}`, { plan }, signal)
}

export function getSettings(signal?: AbortSignal) {
  return request<SettingsResponse>('GET', '/settings', undefined, signal)
}

export function getSources(signal?: AbortSignal) {
  return request<Sources>('GET', '/sources', undefined, signal)
}

/** v1.3: replay the HR file through live calibration on this plan (deterministic in demo mode). */
export function liveReplay(plan: PracticePlan, signal?: AbortSignal) {
  return request<LiveReplay>('POST', '/live/replay?demo=1', { plan }, signal)
}

export function getNodeLatest(signal?: AbortSignal) {
  return request<NodeLatest>('GET', '/node/latest', undefined, signal)
}
