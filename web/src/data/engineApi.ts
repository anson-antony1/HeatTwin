import type { PracticePlan } from './llmPlan'

// Typed client for the engine's /simulate and /optimize (CONTRACTS.md v1.2).
// Only the fields the UI reads are typed; the engine may send more.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? 'http://localhost:8000'

export type AthleteStatus = 'below_limit' | 'near_limit' | 'over_limit'

export interface SimAthlete {
  id: string
  name?: string
  core_c_p50: number[]
  core_c_p95: number[]
  first_cross_min?: number | null
  peak_core_c_p95: number
  status: AthleteStatus
}

export interface SimulationResult {
  plan_id: string
  step_min: number
  times: string[]
  athletes: SimAthlete[]
  limit_core_c: number
  fhsaa_violations: { drill_id: string; rule: string; detail: string }[]
  training_load_met_min: number
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

export class EngineError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${ENGINE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch {
    throw new EngineError(0, `Can't reach the engine at ${ENGINE}. Is it running?`)
  }
  if (!r.ok) {
    let msg = r.statusText
    try {
      const j = await r.json()
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* keep statusText */
    }
    throw new EngineError(r.status, msg)
  }
  return r.json() as Promise<T>
}

/** Roster and weather fall back to the engine's labelled fixtures, which this app also reads. */
export function simulatePlan(plan: PracticePlan, signal?: AbortSignal) {
  return post<SimulationResult>('/simulate?demo=1', { plan }, signal)
}

export function optimizePlan(plan: PracticePlan, signal?: AbortSignal) {
  return post<OptimizeResult>('/optimize?demo=1', { plan }, signal)
}

/** Resample a result series to one value per practice minute. */
export function perMinute(series: number[], stepMin: number, minutes: number): number[] {
  if (stepMin === 1 && series.length >= minutes + 1) return series.slice(0, minutes + 1)
  const out: number[] = []
  for (let m = 0; m <= minutes; m++) {
    const x = m / stepMin
    const i = Math.min(series.length - 1, Math.floor(x))
    const j = Math.min(series.length - 1, i + 1)
    const f = x - Math.floor(x)
    out.push(series[i] + (series[j] - series[i]) * f)
  }
  return out
}
