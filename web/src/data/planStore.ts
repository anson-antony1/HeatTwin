import { useSyncExternalStore } from 'react'
import type { ContractGear, PlanDraft, PracticePlan } from './llmPlan'
import { optimizePlan, simulatePlan, type OptimizeResult, type SimulationResult } from './engineApi'
import { contractToUi, DEFAULT_CONTRACT_PLAN } from './fixtures'
import { engine } from './engine'
import { weatherStore } from './weather'

// Today's plan, as confirmed by the coach, plus what the engine said about it.
// Voice → Gemini (/plan/parse_audio) → coach confirms → /simulate → this store
// → the live replay and every athlete's page. Optional /optimize swaps in the
// engine's rewritten plan.

export type PlanPhase = 'idle' | 'simulating' | 'optimizing' | 'ready' | 'error'

export interface PlanState {
  phase: PlanPhase
  plan: PracticePlan
  source: 'fixture' | 'voice' | 'optimized' | 'edited'
  /** The draft the coach confirmed (transcript, assumptions) — kept for display. */
  draft: PlanDraft | null
  sim: SimulationResult | null
  opt: OptimizeResult | null
  /** Simulation of the plan as the coach said it, before any optimization. */
  original: SimulationResult | null
  confirmedAt: number | null
  error: string | null
  /** What was live before the last change, for one-step undo. */
  previous: Snapshot | null
}

type Snapshot = Pick<PlanState, 'plan' | 'source' | 'draft' | 'sim' | 'opt' | 'original' | 'confirmedAt'>

function snapshot(): Snapshot {
  const { plan, source, draft, sim, opt, original, confirmedAt } = state
  return { plan, source, draft, sim, opt, original, confirmedAt }
}

const STORAGE_KEY = 'heattwin.plan.v1'

let state: PlanState = {
  phase: 'idle',
  plan: DEFAULT_CONTRACT_PLAN,
  source: 'fixture',
  draft: null,
  sim: null,
  opt: null,
  original: null,
  confirmedAt: null,
  error: null,
  previous: null,
}

const listeners = new Set<() => void>()

function set(patch: Partial<PlanState>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

function persist() {
  try {
    const { plan, source, draft, sim, opt, original, confirmedAt } = state
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, source, draft, sim, opt, original, confirmedAt }))
  } catch {
    /* storage full or blocked — the plan still works for this session */
  }
}

/** Hand the plan (and its engine result) to the live replay, keeping play state. */
function apply(plan: PracticePlan, sim: SimulationResult | null) {
  const wasRunning = engine.getSnapshot().running
  engine.setPlan(contractToUi(plan), sim)
  if (wasRunning) engine.play()
}

/** The live forecast for the practice day (Settings → location), in the engine's shape — or none. */
function liveWeather() {
  const w = weatherStore.get()
  return w.location && w.engineHours ? (w.engineHours as unknown as Record<string, unknown>[]) : undefined
}

/** Put the plan on the live forecast's day (same local start time and the site's UTC offset). */
function onForecastDay(plan: PracticePlan): PracticePlan {
  const w = weatherStore.get()
  if (!w.location || !w.forecastDate || !w.engineHours?.length) return plan
  const start = `${w.forecastDate}${plan.start.slice(10, 19)}${w.engineHours[0].time.slice(19)}`
  return start === plan.start ? plan : { ...plan, start }
}

let inflight: AbortController | null = null

export const planStore = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,

  /** Coach confirmed the AI's draft: run the twin on it. */
  async confirm(draft: PlanDraft) {
    inflight?.abort()
    inflight = new AbortController()
    const previous = snapshot()
    set({ phase: 'simulating', error: null })
    const plan = onForecastDay(draft.plan)
    try {
      const sim = await simulatePlan(plan, inflight.signal, liveWeather())
      set({ phase: 'ready', draft, plan, source: 'voice', opt: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(plan, sim)
      persist()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      set({ phase: 'error', error: (e as Error).message })
    }
  },

  /** A plan the coach built by hand in the Practice plan editor. */
  async applyPlan(edited: PracticePlan) {
    inflight?.abort()
    inflight = new AbortController()
    const previous = snapshot()
    set({ phase: 'simulating', error: null })
    const plan = onForecastDay(edited)
    try {
      const sim = await simulatePlan(plan, inflight.signal, liveWeather())
      set({ phase: 'ready', plan, source: 'edited', draft: null, opt: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(plan, sim)
      persist()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      set({ phase: 'error', error: (e as Error).message })
    }
  },

  /** Ask the engine to rewrite the current plan so everyone stays under the line. */
  async optimize() {
    inflight?.abort()
    inflight = new AbortController()
    const previous = snapshot()
    set({ phase: 'optimizing', error: null })
    try {
      const opt = await optimizePlan(onForecastDay(state.plan), inflight.signal, liveWeather())
      set({ phase: 'ready', opt, plan: opt.plan, sim: opt.optimized, original: opt.original, source: 'optimized', previous })
      apply(opt.plan, opt.optimized)
      persist()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      set({ phase: 'error', error: (e as Error).message })
    }
  },

  /** Put back whatever was live before the last voice plan or optimization. */
  undo() {
    const prev = state.previous
    if (!prev) return
    set({ ...prev, phase: prev.sim ? 'ready' : 'idle', error: null, previous: null })
    apply(prev.plan, prev.sim)
    if (prev.source === 'fixture') {
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        /* ignore */
      }
    } else persist()
  },

  /**
   * Re-run the engine on the plan in use — at startup (so the engine's physics,
   * not the browser stand-in, drives the dashboard) and whenever the live
   * forecast changes. Keeps the plan's source; quiet on failure (the replay
   * keeps whatever it had).
   */
  async remodel() {
    if (state.phase === 'simulating' || state.phase === 'optimizing') return
    inflight?.abort()
    inflight = new AbortController()
    const plan = onForecastDay(state.plan)
    try {
      const sim = await simulatePlan(plan, inflight.signal, liveWeather())
      set({ plan, sim, original: state.source === 'optimized' ? state.original : sim, phase: 'ready' })
      apply(plan, sim)
      if (state.source !== 'fixture') persist()
    } catch {
      /* engine unreachable — stay on the stand-in model */
    }
  },

  dismissError() {
    set({ phase: state.sim ? 'ready' : 'idle', error: null })
  },

  /** Back to the fixture plan and the browser-side model. */
  clear() {
    inflight?.abort()
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* ignore */
    }
    set({ phase: 'idle', plan: DEFAULT_CONTRACT_PLAN, source: 'fixture', draft: null, sim: null, opt: null, original: null, confirmedAt: null, error: null, previous: null })
    apply(DEFAULT_CONTRACT_PLAN, null)
    void planStore.remodel()
  },

  /** Restore the last confirmed plan after a reload. */
  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<PlanState>
      if (!saved.plan || !saved.sim) return
      set({ ...saved, phase: 'ready', error: null, previous: null } as PlanState)
      apply(saved.plan, saved.sim)
    } catch {
      /* corrupt entry — start fresh */
    }
  },
}

// Live forecast arrived or the location changed: model the plan on it.
let lastHours: unknown = null
weatherStore.subscribe(() => {
  const hours = weatherStore.get().engineHours
  if (hours && hours !== lastHours) {
    lastHours = hours
    void planStore.remodel()
  }
})

export function usePlanState(): PlanState {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}

/** The gear one athlete wears for a drill (per-athlete acclimatization overrides win). */
export function gearFor(d: PracticePlan['drills'][number], athleteId: string): ContractGear {
  return d.gear_by_athlete?.[athleteId] ?? d.gear
}
