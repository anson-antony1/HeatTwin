import { useSyncExternalStore } from 'react'
import type { ContractGear, PlanDraft, PracticePlan } from './llmPlan'
import { isUnreachable, nodeDemoActive, optimizePlan, simulatePlan, type OptimizePreset, type OptimizeResult, type SimulationResult } from './engineApi'
import { DEFAULT_CONTRACT_PLAN, FIXTURE_ROSTER } from './fixtures'
import { engineMeta } from './engineMeta'
import { engine, type ReplayFor } from './engine'
import { isDemoPlan } from './selectors'

// Today's plan, plus what the engine said about it.
// App start → GET /demo/inputs (the engine's demo plan) → POST /simulate?demo=1
// → this store → Plan, Live roster and every athlete page. Voice (Gemini
// /plan/parse_audio → the coach presses Confirm), the plan editor and /optimize
// replace the plan and re-run the engine. If the engine can't be reached the
// plan structure stays on screen with no numbers, badged "offline fallback".

export type PlanPhase = 'idle' | 'simulating' | 'optimizing' | 'ready' | 'error'

export interface PlanState {
  phase: PlanPhase
  plan: PracticePlan
  source: 'fixture' | 'voice' | 'optimized' | 'edited'
  /** The draft the coach confirmed (transcript, assumptions) — kept for display. */
  draft: PlanDraft | null
  sim: SimulationResult | null
  opt: OptimizeResult | null
  /** The /optimize preset behind `opt` (null when the plan isn't an optimizer result). */
  preset: OptimizePreset | null
  /** Simulation of the plan as the coach said it, before any optimization. */
  original: SimulationResult | null
  confirmedAt: number | null
  error: string | null
  /** What was live before the last change, for one-step undo (kept across a reload; its results are re-run). */
  previous: Snapshot | null
  /** The engine is unreachable: no numbers anywhere ("—"), the plan structure stays, badged "offline fallback". */
  offline: boolean
}

type Snapshot = Pick<PlanState, 'plan' | 'source' | 'draft' | 'sim' | 'opt' | 'preset' | 'original' | 'confirmedAt'>

function snapshot(): Snapshot {
  const { plan, source, draft, sim, opt, preset, original, confirmedAt } = state
  return { plan, source, draft, sim, opt, preset, original, confirmedAt }
}

const STORAGE_KEY = 'heattwin.plan.v2'

const INITIAL: PlanState = {
  phase: 'idle',
  plan: DEFAULT_CONTRACT_PLAN,
  source: 'fixture',
  draft: null,
  sim: null,
  opt: null,
  preset: null,
  original: null,
  confirmedAt: null,
  error: null,
  previous: null,
  offline: false,
}

let state: PlanState = INITIAL

const listeners = new Set<() => void>()

function set(patch: Partial<PlanState>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function persist() {
  try {
    const { plan, source, draft, preset, confirmedAt, previous } = state
    // Only what the coach decided is kept; every number is re-run on the engine after a reload. The plan before the
    // last change is kept too, so Undo still works after a reload.
    const prev = previous
      ? { plan: previous.plan, source: previous.source, draft: previous.draft, preset: previous.preset ?? null, confirmedAt: previous.confirmedAt }
      : null
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ plan, source, draft, preset, confirmedAt, previous: prev }))
  } catch {
    /* storage full or blocked — the plan still works for this session */
  }
}

function forget() {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/** The HR file was recorded on the engine's demo plan: replay it only while that plan (same id and drills) is on screen. */
function replayFor(plan: PracticePlan): ReplayFor {
  if (sensorWeather()) return 'sensor'
  const inputs = engineMeta.get().inputs
  if (!inputs) return 'unknown'
  return isDemoPlan(plan, inputs) ? 'this_plan' : 'other_plan'
}

/** Hand the plan and its engine result to the session, keeping play state. */
function apply(plan: PracticePlan, sim: SimulationResult | null) {
  sensorWasOn = sensorWeather()
  const wasRunning = engine.getSnapshot().running
  if (sim) engine.setPlan(plan, sim, replayFor(plan))
  else if (state.offline) engine.setOffline(plan, (engineMeta.get().inputs?.roster ?? FIXTURE_ROSTER).map((a) => a.id))
  else engine.setPlan(plan, null, 'unknown')
  if (wasRunning) engine.play()
}

/** The engine is down: keep the plan on screen with no numbers. */
function goOffline(error: string | null = null) {
  engineMeta.markOffline()
  set({ phase: error ? 'error' : 'idle', error, sim: null, offline: true })
  apply(state.plan, null)
}

let inflight: AbortController | null = null

/** The sensor demo is running: every simulation uses its weather (the heated globe stands in for the sun). */
function sensorWeather(): boolean {
  return nodeDemoActive(engineMeta.get().node)
}

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
  set({ ...patch, phase: 'ready', error: null, offline: false })
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
    watchNode()
  },

  /** Re-run /simulate on the current plan (keeps its source); an optimized plan re-runs its optimization. */
  async refresh() {
    if (state.source === 'optimized' && state.previous && !state.opt) {
      const base = state.previous.plan
      const signal = begin('optimizing')
      try {
        const opt = await optimizePlan(base, signal, state.preset ?? 'max_load')
        landed({ opt, plan: opt.plan, sim: opt.optimized, original: opt.original, previous: { ...state.previous, sim: opt.original } })
        apply(opt.plan, opt.optimized)
      } catch (e) {
        fail(e)
      }
      return
    }
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(state.plan, signal, sensorWeather())
      landed({ sim, original: state.source === 'optimized' && state.original ? state.original : sim })
      apply(state.plan, sim)
    } catch (e) {
      fail(e)
    }
  },

  /**
   * The sensor's weather changed (or the sensor demo started/stopped): re-run the plan on screen. An optimized plan
   * is re-simulated, not re-optimized, so the coach sees the same plan turn red as the "sun" comes out.
   */
  async resimulate() {
    if (state.phase === 'simulating' || state.phase === 'optimizing' || state.offline) return
    const sensor = sensorWeather()
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(state.plan, signal, sensor)
      landed({ sim })
      // Sensor still running: swap the numbers in place (keep the clock). Demo started/stopped: full hand-off, so the
      // HR replay is paused (sensor) or reloaded (pinned forecast again).
      if (sensor && sensorWasOn) engine.updateSim(sim)
      else apply(state.plan, sim)
    } catch (e) {
      fail(e)
    }
  },

  /** The coach pressed Confirm on the AI's draft: run the twin on it. */
  async confirm(draft: PlanDraft) {
    const previous = snapshot()
    const signal = begin('simulating')
    try {
      const sim = await simulatePlan(draft.plan, signal, sensorWeather())
      landed({ draft, plan: draft.plan, source: 'voice', opt: null, preset: null, sim, original: sim, confirmedAt: Date.now(), previous })
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
      const sim = await simulatePlan(plan, signal, sensorWeather())
      landed({ plan, source: 'edited', draft: null, opt: null, preset: null, sim, original: sim, confirmedAt: Date.now(), previous })
      apply(plan, sim)
      persist()
    } catch (e) {
      fail(e)
    }
  },

  /**
   * Ask the engine to rewrite the plan so everyone is estimated under the line. `max_load` keeps the most training
   * load; `fewest_changes` makes the smallest edit that meets every rule. Both presets start from the plan the coach
   * entered: after one optimization, another preset re-optimizes the original, and Undo still returns to it.
   */
  async optimize(preset: OptimizePreset = 'max_load') {
    const again = state.source === 'optimized' && state.previous != null
    const previous = again ? state.previous! : snapshot()
    const base = again ? state.previous!.plan : state.plan
    const signal = begin('optimizing')
    try {
      const opt = await optimizePlan(base, signal, preset)
      landed({ opt, preset, plan: opt.plan, sim: opt.optimized, original: opt.original, source: 'optimized', previous })
      apply(opt.plan, opt.optimized)
      persist()
    } catch (e) {
      fail(e)
    }
  },

  /** Put back whatever was live before the last voice plan, edit or optimization. */
  undo() {
    const prev = state.previous
    if (!prev) return
    set({ ...prev, phase: prev.sim ? 'ready' : 'idle', error: null, previous: null })
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
    set({ phase: 'idle', plan, source: 'fixture', draft: null, sim: null, opt: null, preset: null, original: null, confirmedAt: null, error: null, previous: null })
    void planStore.refresh()
  },

  /** Restore the last plan the coach confirmed (its numbers are re-run on the engine by `boot`/`refresh`). */
  restore() {
    try {
      const raw = storage()?.getItem(STORAGE_KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Partial<PlanState> & { previous?: Partial<Snapshot> | null }
      if (!saved.plan?.drills?.length) return
      set({
        plan: saved.plan,
        source: saved.source ?? 'edited',
        draft: saved.draft ?? null,
        opt: null,
        preset: saved.preset ?? null,
        original: null,
        confirmedAt: saved.confirmedAt ?? null,
        sim: null,
        phase: 'idle',
        error: null,
        previous: saved.previous?.plan
          ? ({ plan: saved.previous.plan, source: saved.previous.source ?? 'fixture', draft: saved.previous.draft ?? null,
              preset: saved.previous.preset ?? null, confirmedAt: saved.previous.confirmedAt ?? null, sim: null, opt: null, original: null } as Snapshot)
          : null,
      })
    } catch {
      /* corrupt entry — start fresh */
    }
  },

  /** Tests only. */
  _reset() {
    inflight?.abort()
    state = INITIAL
    listeners.forEach((fn) => fn())
  },
}

export function usePlanState(): PlanState {
  return useSyncExternalStore(planStore.subscribe, planStore.get)
}

/** The gear one athlete wears for a drill (per-athlete acclimatization overrides win). */
export function gearFor(d: PracticePlan['drills'][number], athleteId: string): ContractGear {
  return d.gear_by_athlete?.[athleteId] ?? d.gear
}

// Sensor demo → plan: when /node/latest's demo_version changes (sun moved enough, or the demo started/stopped),
// re-simulate the plan on screen with the sensor's weather. A run already in flight is followed by one more.
let lastNodeVersion = 0
let sensorWasOn = false
let pendingNode = false
let watching = false

function watchNode() {
  if (watching) return
  watching = true
  lastNodeVersion = engineMeta.get().node?.demo_version ?? 0
  engineMeta.startNodePolling()
  engineMeta.subscribe(() => {
    const v = engineMeta.get().node?.demo_version ?? 0
    if (v === lastNodeVersion) return
    lastNodeVersion = v
    if (state.phase === 'simulating' || state.phase === 'optimizing') pendingNode = true
    else void planStore.resimulate()
  })
  planStore.subscribe(() => {
    if (pendingNode && state.phase !== 'simulating' && state.phase !== 'optimizing') {
      pendingNode = false
      void planStore.resimulate()
    }
  })
}
