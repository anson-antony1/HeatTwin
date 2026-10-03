import { ENGINE_URL } from './config'

// Thin, typed wrappers over the engine endpoints the voice tools use (CONTRACTS.md v1.2).

export interface GuardHit { rule: string; match: string; start: number; end: number }
export interface GuardResult { ok: boolean; redacted_text: string; hits: GuardHit[] }

export interface PlanSummary {
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

export interface SimAthlete {
  id: string
  name?: string
  core_c_p50: number[]
  core_c_p95: number[]
  first_cross_min?: number | null
  peak_core_c_p95: number
  status: 'below_limit' | 'near_limit' | 'over_limit'
}

export interface SimulationResult {
  plan_id: string
  step_min: number
  times: string[]
  athletes: SimAthlete[]
  limit_core_c: number
  fhsaa_violations: { drill_id: string; rule: string; detail: string }[]
  labels: string[]
}

export interface OptimizeResult {
  feasible: boolean
  load_kept_pct: number
  changes: { kind: string; move?: string; drill_id: string; detail: string }[]
  top_changes?: { detail: string; heat_reduction_c: number }[]
  top_changes_text?: string
  optimized: SimulationResult
  plan: { drills: { duration_min: number }[] }
  infeasible_reasons?: string[]
  labels?: string[]
  search: Record<string, unknown>
}

export type WhatIfChange =
  | { drill_id: string; gear?: string; duration_min?: number; shade?: boolean; intensity?: string; move_to?: number; remove?: boolean }
  | { add_break_after: string; minutes?: number }

export interface WhatIfResult { before: PlanSummary; after: PlanSummary; delta_team_mean_p95_c: number; say: string; labels: string[] }

export interface AthleteStatus {
  id: string
  name?: string
  position?: string
  acclimatization_day?: number
  gear_limit?: string
  peak_p50_c: number
  peak_p95_c: number
  status: string
  first_cross_min: number | null
  limit_c: number
  say: string
  labels: string[]
}

export interface FieldConditions {
  hours: { time: string; wbgt_f: number; fhsaa_zone: number; air_temp_c: number; rh_pct: number; source: string }[]
  sources: string[]
  say: string
  labels: string[]
}

async function call<T>(path: string, init?: RequestInit, fetchImpl: typeof fetch = fetch): Promise<T> {
  const r = await fetchImpl(`${ENGINE_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text()}`)
  return (await r.json()) as T
}

export const engineApi = {
  simulate: (f?: typeof fetch) => call<SimulationResult>('/simulate?demo=1', { method: 'POST', body: '{}' }, f),
  optimize: (preset: 'max_load' | 'fewest_changes' = 'max_load', f?: typeof fetch) =>
    call<OptimizeResult>(`/optimize?demo=1&preset=${preset}`, { method: 'POST', body: '{}' }, f),
  whatIf: (change: WhatIfChange, f?: typeof fetch) =>
    call<WhatIfResult>('/what_if', { method: 'POST', body: JSON.stringify({ change }) }, f),
  athleteStatus: (athlete: string, f?: typeof fetch) =>
    call<AthleteStatus>(`/athlete_status?athlete_id=${encodeURIComponent(athlete)}`, undefined, f),
  fieldConditions: (f?: typeof fetch) => call<FieldConditions>('/field_conditions', undefined, f),
  guard: (text: string, f?: typeof fetch) =>
    call<GuardResult>('/guard', { method: 'POST', body: JSON.stringify({ text }) }, f),
}
