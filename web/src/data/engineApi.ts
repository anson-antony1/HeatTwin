import type { ContractGear, ContractIntensity, PracticePlan } from './llmPlan'

// Typed client for the HeatTwin engine (CONTRACTS.md v1.1–v1.5). Every heat,
// zone, status and HR number the web shows comes from one of these responses.
// Demo calls carry ?demo=1 (fixed seed, pinned saved forecast). Only the fields
// the UI reads are typed; the engine may send more.

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
  source: 'nws_forecast' | 'field_node' | 'assimilated' | 'fixture' | string
  /** v1.6: a live session on the pinned forecast shifted to now, by this many minutes ("forecast snapshot (time-shifted)"). */
  time_shifted_min?: number
  /** v1.7: the Arduino's air temperature with humidity / wind / sunlight from NWS (`weather_from` "nws") or from the
   *  time-shifted pinned forecast ("snapshot"). */
  field_mode?: boolean
  weather_from?: 'nws' | 'snapshot'
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

export type OptimizePreset = 'max_load' | 'fewest_changes'

/** v1.4: on OptimizeResult when preset=fewest_changes. */
export interface FewestChanges {
  cap: number
  min_compliant_changes: number | null
  searched_caps: number[]
  fell_back: boolean
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
  fewest_changes?: FewestChanges
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

export interface Gates {
  crossing: boolean
  persistent: boolean
  coverage_ok: boolean
  coverage_fraction: number
  n_updates: number
  flag: boolean
  held_by: string[]
  message: string
}

/** One athlete's re-forecast after an HR calibration update (replay frame or live entry). */
export interface CalibratedCurve {
  core_c_p50: number[]
  core_c_p95: number[]
  peak_core_c_p95: number
  status: AthleteStatus
  first_cross_min: number | null
}

export interface ReplayFrame {
  /** Minutes since plan start. */
  minute: number
  athlete_id: string
  hr_bpm: number
  calib: { met_scale: number; met_scale_sd: number }
  gates: Gates
  athlete: CalibratedCurve
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
    /** v1.5 */
    date?: string | null
    device?: string | null
    /** v1.5: "replay · <date> · <device>" or "replay · synthetic HR file (not a real athlete)". */
    label?: string
  }
  plan_forecast: SimulationResult
  frames: ReplayFrame[]
  /** athlete_id → [minute, bpm]. */
  hr_series: Record<string, [number, number][]>
  /** v1.7: the athlete-only re-plan offered from each athlete's first flagged frame (with its plan). */
  suggestions?: Record<string, LiveSuggestion>
  labels: string[]
}

/** v1.5 GET /live/state — the live HR session (poll every few seconds). */
export interface LiveAthlete {
  hr_bpm: number
  ts: string
  /** Display name of the strap, e.g. "Amazfit Helio Strap". */
  device: string
  replay: boolean
  age_s: number
  receiving: boolean
  minute: number
  calib: { met_scale: number; met_scale_sd: number } | null
  gates: Gates | null
  athlete: CalibratedCurve | null
  /** v1.6 live demo: the plan drill this athlete's HR is read against (e.g. the conditioning drill). */
  live_demo?: { drill_id: string; drill: string; intensity: string }
  /** v1.7: the engine's athlete-only re-plan while the gate flags a crossing (the plan itself comes with /live/apply). */
  suggestion?: LiveSuggestion
}

/** v1.7 engine/suggest.py: ≤ 2 changes for one athlete, rest of session; every sentence already passed the guard. */
export interface LiveSuggestion {
  athlete_id: string
  changes: { kind: 'rest_start' | 'rotate_out' | 'gear_down'; drill_id: string; detail: string }[]
  text: string
  /** The guarded result sentence: "HR-calibrated re-forecast peak 39.42 → 38.79 °C (p95), under the planning line. …" */
  outcome: string
  before: { peak_core_c_p95: number; first_cross_min: number | null }
  after: { peak_core_c_p95: number; first_cross_min: number | null; under_line: boolean }
  at_minute: number
  /** Live only: the reading time it was computed at; Apply sends it back (409 if a newer one replaced it). */
  computed_at?: string
  labels: string[]
  /** Replay only: the changed plan (a live session sends it with POST /live/apply instead). */
  plan?: PracticePlan
}

export interface LiveState {
  active: boolean
  receiving: boolean
  plan_id?: string
  plan_start?: string
  now?: string
  /** Minutes since plan start (wall clock). */
  minute?: number
  athletes: Record<string, LiveAthlete>
  /** Whole roster, latest calibration (plan forecast for athletes without HR). */
  reforecast?: SimulationResult
  /** v1.7: athletes only in the live session (the live-demo profile), shown in the roster while it runs. */
  roster_extra?: RosterAthlete[]
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
    forecast_wbgt_f: number | null
    field_minus_forecast_f: number | null
    fhsaa_zone: number
    globe_calibrated: boolean
    tub_temp_c?: number | null
  }
  series: { ts: string; node_wbgt_f: number; forecast_wbgt_f: number }[]
  file: string | null
  labels: string[]
  /** Indoor sensor demo: > 0 while it runs; bumps when the sensor's inferred sun changes enough to change results. */
  demo_version?: number
  /** v1.7: which weather a live session would use now, and how old the Arduino's last reading is. */
  source?: NodeSource
}

/** v1.7 `source` of GET /node/latest and /node/status. `field_sensor_*`: a fresh Arduino reading (air temperature) with
 *  NWS or snapshot humidity / wind / sunlight; `nws` / `snapshot`: no recent reading, so live NWS or the time-shifted
 *  pinned forecast; `none`: no sensor path. `reading_age_s` keeps counting after an unplug (null: never read). */
export interface NodeSource {
  id: 'field_sensor_nws' | 'field_sensor_snapshot' | 'demo_scenario' | 'nws' | 'snapshot' | 'none'
  label: string | null
  mode: 'field' | 'demo'
  sensor_fresh: boolean
  reading_age_s: number | null
  stale_after_s: number
}

/** The indoor sensor demo is running (POST /node demo readings arriving): simulate with ?source=node. */
export function nodeDemoActive(node: NodeLatest | null | undefined): boolean {
  return (node?.demo_version ?? 0) > 0
}

/** GET /weather?lat&lon&date (engine/weather_routes.py). */
export interface WeatherResponse {
  lat: number
  lon: number
  place: string | null
  source: 'nws_forecast' | 'fixture' | 'none'
  now: WeatherHour | null
  next_hours: WeatherHour[]
  day: WeatherHour[]
  fetched_at?: string
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
  nata_ehs?: { status?: string; source?: string; acclimatization_days?: number[]; [k: string]: unknown }
  ksi_cwi?: { status?: string; source?: string; [k: string]: unknown }
  [block: string]: unknown
}

export interface GuardResult {
  ok: boolean
  redacted_text: string
  /** guard.py's own hits (rule redactions). The assist's are in `assist.hits`. */
  hits: { rule: string; [k: string]: unknown }[]
  /** v1.7: which layer blocked — "guard.py" (rules) and/or "assist" (the decision layer's embedding classifier). */
  blocked_by?: ('guard.py' | 'assist')[]
  assist?: { backend: string; p_flag_max: number; hits: { rule: string; [k: string]: unknown }[]; calibrated: boolean; fallback: boolean }
}

export type VoiceIntentName = 'plan_summary' | 'optimize' | 'what_if' | 'athlete_status' | 'field_conditions' | 'unknown'

export interface VoiceSlots {
  athlete_id?: string
  drill_id?: string
  change?: 'gear' | 'duration' | 'shade' | 'intensity' | 'remove' | 'add_break' | 'move'
  gear?: ContractGear
  duration_min?: number
  intensity?: ContractIntensity
  shade?: boolean
  move_to?: number
  preset?: OptimizePreset
}

/** v1.3 POST /voice/answer. `say` is engine-written and guarded; `numbers` lists every number token in it. */
export interface VoiceAnswer {
  intent: VoiceIntentName
  say: string
  numbers: string[]
  data: Record<string, unknown>
  labels: string[]
  /** v1.7: the engine's own two-layer verdict on `say` (the app still asks /guard before showing or speaking it). */
  guard?: { ok: boolean; blocked_by: ('guard.py' | 'assist')[] }
}

/** v1.2 POST /what_if team summaries. */
export interface WhatIfSummary {
  athletes: number
  over_limit: number
  near_limit: number
  max_p95_c: number
  team_mean_p95_c: number
  first_cross_min: number | null
  limit_c: number
  fhsaa_violations: number
  practice_min: number
}

export interface WhatIfResult {
  before: WhatIfSummary
  after: WhatIfSummary
  delta_team_mean_p95_c: number
  say: string
  labels: string[]
}

export type WhatIfChange =
  | { drill_id: string; gear?: ContractGear; duration_min?: number; shade?: boolean; intensity?: ContractIntensity; move_to?: number; remove?: boolean }
  | { add_break_after: string; minutes: number }

/** v1.3 POST /athlete_status. */
export interface AthleteStatusResult {
  id: string
  name: string
  position?: string
  acclimatization_day: number
  gear_limit?: string | null
  peak_p50_c: number
  peak_p95_c: number
  status: AthleteStatus
  first_cross_min: number | null
  limit_c: number
  say: string
  labels: string[]
}

/** v1.3 POST /field_conditions. */
export interface FieldConditions {
  hours: { time: string; wbgt_f: number; fhsaa_zone: number; air_temp_c: number; rh_pct: number; source: string }[]
  sources: string[]
  say: string
  labels: string[]
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

/** The engine is down (not merely refusing a request). */
export function isUnreachable(e: unknown): boolean {
  return e instanceof EngineError && e.unreachable
}

const TIMEOUT_MS = 60_000

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<T> {
  let r: Response
  const timeout = AbortSignal.timeout(timeoutMs)
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
    // FastAPI answers errors as JSON {detail}. A non-JSON 5xx comes from the dev proxy when nothing is listening
    // behind it — i.e. the engine is down.
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

/**
 * Roster and weather fall back to the engine's labelled fixtures.
 * `node`: the sensor demo is running → `/simulate?source=node` (its weather: the heated globe stands in for the sun).
 * Not with ?demo=1, which keeps the saved forecast pinned by design; the seed and ensemble size are the same defaults.
 */
export function simulatePlan(plan: PracticePlan, signal?: AbortSignal, node = false) {
  return request<SimulationResult>('POST', node ? '/simulate?source=node' : '/simulate?demo=1', { plan }, signal)
}

/** Always the pinned, deterministic demo optimizer; the sensor then re-simulates the optimized plan. */
export function optimizePlan(plan: PracticePlan, signal?: AbortSignal, preset: OptimizePreset = 'max_load') {
  return request<OptimizeResult>('POST', `/optimize?demo=1&preset=${preset}`, { plan }, signal)
}

export function getSettings(signal?: AbortSignal) {
  return request<SettingsResponse>('GET', '/settings', undefined, signal)
}

/** v1.6 GET /validation/hr_recording: the real strap recording as calibration evidence (validation/results.json). */
export interface HrRecording {
  synthetic: false
  replay: true
  file: string
  device: string
  date: string
  athlete_ids: string[]
  n_readings: number
  duration_min: number
  hr_bpm: { min: number; mean: number; max: number }
  calibration: null | {
    athlete_id: string
    mapped_drill: { id: string; name: string; intensity: string }
    n_updates: number
    prior_met_scale: number
    prior_met_scale_sd: number
    final_met_scale: number
    final_met_scale_sd: number
  }
  labels: string[]
}

/** null when the engine has no recording (404). */
export async function getHrRecording(signal?: AbortSignal): Promise<HrRecording | null> {
  try {
    return await request<HrRecording>('GET', '/validation/hr_recording', undefined, signal)
  } catch (e) {
    if (e instanceof EngineError && e.status === 404) return null
    throw e
  }
}

export function getSources(signal?: AbortSignal) {
  return request<Sources>('GET', '/sources', undefined, signal)
}

/** v1.2: one plan edit → before/after team summary + an engine sentence. */
export function whatIf(change: WhatIfChange, plan: PracticePlan, signal?: AbortSignal) {
  return request<WhatIfResult>('POST', '/what_if?demo=1', { change, plan }, signal)
}

/** v1.3: one athlete's estimate on the plan sent (id or name). */
export function athleteStatus(athlete: string, plan: PracticePlan, signal?: AbortSignal) {
  return request<AthleteStatusResult>('POST', '/athlete_status?demo=1', { athlete, plan }, signal)
}

/** v1.3: hourly WBGT / FHSAA zone over the plan's window. */
export function fieldConditions(plan: PracticePlan, signal?: AbortSignal) {
  return request<FieldConditions>('POST', '/field_conditions?demo=1', { plan }, signal)
}

/** v1.3: replay the HR file through live calibration on this plan (deterministic in demo mode). */
export function liveReplay(plan: PracticePlan, signal?: AbortSignal) {
  return request<LiveReplay>('POST', '/live/replay?demo=1', { plan }, signal)
}

/** v1.5: the live HR session (strap → engine/hr_bridge.py → POST /hr). */
/** v1.7: apply the live suggestion for one athlete; returns the plan the live session now runs. */
export function postLiveApply(athleteId: string, computedAt?: string) {
  return request<{ ok: boolean; plan: PracticePlan; applied: Pick<LiveSuggestion, 'text' | 'changes' | 'before' | 'after'>; labels: string[] }>(
    'POST', '/live/apply', { athlete_id: athleteId, computed_at: computedAt })
}

export function getLiveState(signal?: AbortSignal) {
  return request<LiveState>('GET', '/live/state', undefined, signal, 10_000)
}

export function getNodeLatest(signal?: AbortSignal) {
  return request<NodeLatest>('GET', '/node/latest', undefined, signal)
}

/** Engine weather for a location: NWS hourly forecast + Liljegren WBGT + FHSAA zone (fixture when NWS is unreachable). */
export function getWeather(lat: number, lon: number, date: string | null, signal?: AbortSignal) {
  const q = new URLSearchParams({ lat: lat.toFixed(4), lon: lon.toFixed(4) })
  if (date) q.set('date', date)
  return request<WeatherResponse>('GET', `/weather?${q}`, undefined, signal, 30_000)
}

/** engine/guard.py over HTTP: {ok, redacted_text, hits}. */
export function guardText(text: string, signal?: AbortSignal) {
  return request<GuardResult>('POST', '/guard', { text }, signal, 20_000)
}

// ── v1.7: the FREE voice path (engine/decide_routes.py) — no paid API; Gemini stays optional ──

/** What the decision layer routes to: the engine's intents plus `plan_entry` (handled by /plan/parse_local, not /voice/answer). */
export type DecideIntent = VoiceIntentName | 'plan_entry'

export interface DecisionInfo {
  decision: string
  choice: string | null
  probabilities: Record<string, number>
  confidence: number
  abstain: boolean
  top2: string[]
  backend: string
  calibrated: boolean
  note?: string
}

/** One of the two options of "Did you mean …?"; `choices` is sent back to /voice/decide to confirm it. */
export interface DidYouMeanOption {
  label: string
  choices: DecideChoices
  p: number
}

export interface DecideChoices {
  intent?: string
  athlete_id?: string
  drill_id?: string
}

export interface DecideResult {
  transcript: string
  intent: DecideIntent
  slots: VoiceSlots
  unresolved: string[]
  /** True → do not act: ask `asking` ("intent" | "athlete" | "drill") with `did_you_mean` (the two most probable options). */
  abstain: boolean
  asking: 'intent' | 'athlete' | 'drill' | null
  did_you_mean: DidYouMeanOption[]
  decisions: Record<string, DecisionInfo | null>
  source: 'local'
  backend: string
  labels: string[]
}

export interface VoiceStatus {
  decide: { backend: string; label: string; fallback: boolean; reason: string | null; calibrated: boolean }
  gemini: { configured: boolean; paid_apis_disabled: boolean }
  stt: { whisper: { installed: boolean; cached: boolean; ready: boolean; model: string } }
  tts: { elevenlabs: boolean; fallback: string }
}

export function voiceStatus(signal?: AbortSignal) {
  return request<VoiceStatus>('GET', '/voice/status', undefined, signal, 10_000)
}

/** Transcript → typed routing (engine/decide.py). `choices` = the coach's answers to an earlier "Did you mean …?". */
export function voiceDecide(req: { text: string; plan?: PracticePlan; choices?: DecideChoices }, signal?: AbortSignal) {
  return request<DecideResult>('POST', '/voice/decide', req, signal, 20_000)
}

export interface VoiceAnswerRequest {
  intent: VoiceIntentName
  slots?: VoiceSlots
  plan: PracticePlan
  /** v1.4: the coach's words (the engine states its boundary first when they ask for clearance). */
  question?: string
}

/** v1.3: the engine runs the tool for an intent and writes the sentence. */
export function voiceAnswer(req: VoiceAnswerRequest, signal?: AbortSignal) {
  return request<VoiceAnswer>('POST', '/voice/answer?demo=1', { slots: {}, ...req }, signal)
}
