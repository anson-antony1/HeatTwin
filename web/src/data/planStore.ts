import { useSyncExternalStore } from 'react'
import type { ContractGear, PlanDraft, PracticePlan } from './llmPlan'
import { optimizePlan, simulatePlan, type OptimizeResult, type SimulationResult } from './engineApi'
import { contractToUi, DEFAULT_CONTRACT_PLAN } from './fixtures'
import { engine } from './engine'

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
    try {
      const sim = await simulatePlan(draft.plan, inflight.signal)
      set({ phase: 'ready', draft, plan: draft.plan, source: 'voice', opt: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(draft.plan, sim)
      persist()
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      set({ phase: 'error', error: (e as Error).message })
    }
  },

  /** A plan the coach built by hand in the Practice plan editor. */
  async applyPlan(plan: PracticePlan) {
    inflight?.abort()
    inflight = new AbortController()
    const previous = snapshot()
    set({ phase: 'simulating', error: null })
    try {
      const sim = await simulatePlan(plan, inflight.signal)
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
      const opt = await optimizePlan(state.plan, inflight.signal)
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

export function usePlanState(): PlanState {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}

/** The gear one athlete wears for a drill (per-athlete acclimatization overrides win). */
export function gearFor(d: PracticePlan['drills'][number], athleteId: string): ContractGear {
  return d.gear_by_athlete?.[athleteId] ?? d.gear
}
