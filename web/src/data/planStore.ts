import { useSyncExternalStore } from 'react'
import type { ContractGear, PlanDraft, PracticePlan } from './llmPlan'
import { isUnreachable, optimizePlan, simulatePlan, type OptimizeResult, type SimulationResult } from './engineApi'
import { DEFAULT_CONTRACT_PLAN, FIXTURE_ROSTER } from './fixtures'
import { engineMeta } from './engineMeta'
import { engine } from './engine'
import { offlineSimulate, type OfflineResult } from '../offline/standIn'

// Today's plan, plus what the engine said about it.
// App start → GET /demo/inputs (the engine's demo plan) → POST /simulate?demo=1
// → this store → Plan, Live roster and every athlete page. Voice (Gemini
// /plan/parse_audio → coach confirms), the plan editor and /optimize replace
// the plan and re-run the engine. If the engine can't be reached, `offline`
// holds the in-browser stand-in's numbers, which every view badges
// "OFFLINE FALLBACK — not the validated model".

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
  /** Engine unreachable: the stand-in's numbers for this plan (OFFLINE FALLBACK). Null whenever the engine answered. */
  offline: OfflineResult | null
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
  offline: null,
}

const listeners = new Set<() => void>()

function set(patch: Partial<PlanState>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

function persist() {
  try {
    const { plan, source, draft, opt, original, confirmedAt } = state
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, source, draft, opt, original, confirmedAt }))
  } catch {
    /* storage full or blocked — the plan still works for this session */
  }
}

function forget() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** Hand the plan and its engine result (or the offline stand-in) to the live session, keeping play state. */
function apply(plan: PracticePlan, sim: SimulationResult | null) {
  const wasRunning = engine.getSnapshot().running
  if (sim) engine.setPlan(plan, sim)
  else if (state.offline) engine.setOffline(plan, state.offline)
  else engine.setPlan(plan, null)
  if (wasRunning) engine.play()
}

/** The engine is down: draw the plan with the badged stand-in. */
function goOffline(error: string | null = null) {
  const roster = engineMeta.get().inputs?.roster ?? FIXTURE_ROSTER
  engineMeta.markOffline()
  set({ phase: error ? 'error' : 'idle', error, sim: null, offline: offlineSimulate(state.plan, roster) })
  apply(state.plan, null)
}

let inflight: AbortController | null = null

function begin(phase: PlanPhase) {
  inflight?.abort()
  inflight = new AbortController()
  set({ phase, error: null })
  return inflight.signal
}

function fail(e: unknown) {
  if ((e as Error).name === 'AbortError') return
  if (isUnreachable(e) && !state.sim) return goOffline((e as Error).message)
  set({ phase: 'error', error: (e as Error).message })
}

function landed(patch: Partial<PlanState>) {
  engineMeta.markOnline()
  set({ ...patch, phase: 'ready', error: null, offline: null })
}

export const planStore = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,

  /** App start: restore any saved plan, load the engine's demo inputs, and simulate the current plan. */
  async boot() {
    planStore.restore()
    const inputs = await engineMeta.load()
    if (!inputs) return goOffline()
    if (state.source === 'fixture') set({ plan: inputs.plan })
    await planStore.refresh()
  },

  /** Re-run /simulate on the current plan (keeps its source). */
  async refresh() {
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(state.plan, signal)
      landed({ sim, original: state.source === 'optimized' && state.original ? state.original : sim })
      apply(state.plan, sim)
    } catch (e) {
      fail(e)
    }
  },

  /** Coach confirmed the AI's draft: run the twin on it. */
  async confirm(draft: PlanDraft) {
    const previous = snapshot()
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(draft.plan, signal)
      landed({ draft, plan: draft.plan, source: 'voice', opt: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(draft.plan, sim)
      persist()
    } catch (e) {
      fail(e)
    }
  },

  /** A plan the coach built by hand in the Practice plan editor. */
  async applyPlan(plan: PracticePlan) {
    const previous = snapshot()
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(plan, signal)
      landed({ plan, source: 'edited', draft: null, opt: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(plan, sim)
      persist()
    } catch (e) {
      fail(e)
    }
  },

  /** Ask the engine to rewrite the current plan so everyone stays under the line. */
  async optimize() {
    const previous = snapshot()
    const signal = begin('optimizing')
    try {
      const opt = await optimizePlan(state.plan, signal)
      landed({ opt, plan: opt.plan, sim: opt.optimized, original: opt.original, source: 'optimized', previous })
      apply(opt.plan, opt.optimized)
      persist()
    } catch (e) {
      fail(e)
    }
  },

  /** Put back whatever was live before the last voice plan or optimization. */
  undo() {
    const prev = state.previous
    if (!prev) return
    set({ ...prev, phase: prev.sim ? 'ready' : 'idle', error: null, previous: null, offline: prev.sim ? null : state.offline })
    if (prev.source === 'fixture') forget()
    else persist()
    if (prev.sim) apply(prev.plan, prev.sim)
    else void planStore.refresh()
  },

  dismissError() {
    set({ phase: state.sim ? 'ready' : 'idle', error: null })
  },

  /** Back to the engine's demo plan, re-simulated. */
  clear() {
    inflight?.abort()
    forget()
    const plan = engineMeta.get().inputs?.plan ?? DEFAULT_CONTRACT_PLAN
    set({ phase: 'idle', plan, source: 'fixture', draft: null, sim: null, opt: null, original: null, confirmedAt: null, error: null, previous: null })
    void planStore.refresh()
  },

  /** Restore the last plan the coach confirmed (its numbers are re-run on the engine by `boot`/`refresh`). */
  restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<PlanState>
      if (!saved.plan) return
      set({
        plan: saved.plan,
        source: saved.source ?? 'edited',
        draft: saved.draft ?? null,
        opt: saved.opt ?? null,
        original: saved.original ?? null,
        confirmedAt: saved.confirmedAt ?? null,
        sim: null,
        phase: 'idle',
        error: null,
        previous: null,
      })
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
