import { useSyncExternalStore } from 'react'
import { getLiveState, type LiveState } from './engineApi'
import type { PracticePlan } from './llmPlan'
import { planMinutes } from './selectors'

// The live HR session (CONTRACTS v1.5): a strap → engine/hr_bridge.py → POST /hr
// → the engine's calibration. The web only polls GET /live/state and shows what
// the engine says: latest HR per mapped athlete, the strap's name, the engine's
// re-forecast, status and gates. No HR is generated in the browser.

/** How often the web re-reads /live/state (UI refresh cadence, not a physiological value). */
export const LIVE_POLL_MS = 3000

let state: LiveState | null = null
const listeners = new Set<() => void>()

function set(next: LiveState | null) {
  state = next
  listeners.forEach((fn) => fn())
}

let timer: number | null = null
let inflight: AbortController | null = null

async function poll() {
  inflight?.abort()
  const ctl = new AbortController()
  inflight = ctl
  try {
    const s = await getLiveState(ctl.signal)
    if (!ctl.signal.aborted) set(s)
  } catch (e) {
    // Unreachable, timed out or an older engine without /live/state: no live session on screen.
    if ((e as Error).name !== 'AbortError' && state !== null) set(null)
  }
}

export const liveStore = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,
  /** Start polling; returns a stop function. */
  start(pollMs = LIVE_POLL_MS) {
    void poll()
    if (timer != null) window.clearInterval(timer)
    timer = window.setInterval(() => void poll(), pollMs)
    return () => {
      if (timer != null) window.clearInterval(timer)
      timer = null
      inflight?.abort()
    }
  },
  /** Tests only. */
  _set(next: LiveState | null) {
    set(next)
  },
}

export function useLiveState(): LiveState | null {
  return useSyncExternalStore(liveStore.subscribe, liveStore.get)
}

/**
 * The engine's provenance label for the strap(s): "live · Amazfit Helio Strap" (or "replay (hr_bridge) · …"), with
 * the live-demo mapping appended when the session has one: "… · live demo · conditioning".
 */
export function liveLabel(s: Pick<LiveState, 'labels'> | null): string | null {
  const strap = s?.labels.find((l) => /^(live|replay \(hr_bridge\)) · /.test(l)) ?? null
  const demo = s?.labels.find((l) => /^live demo · /.test(l))
  return strap && demo ? `${strap} · ${demo}` : strap
}

/**
 * A live session whose straps are being received, on the plan on screen: same plan id and the same length (an
 * optimized plan keeps its id but not its length). `other_plan`: live HR is running on another plan.
 */
export function liveApplies(s: LiveState | null, plan: Pick<PracticePlan, 'id' | 'drills'> | null | undefined): 'on' | 'other_plan' | 'off' {
  if (!s?.active || !s.receiving || !s.reforecast || s.minute == null) return 'off'
  if (!plan || s.plan_id !== plan.id) return 'other_plan'
  const span = Math.round(s.reforecast.times.length * s.reforecast.step_min)
  return span === Math.round(planMinutes(plan)) ? 'on' : 'other_plan'
}
