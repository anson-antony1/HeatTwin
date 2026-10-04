import { useSyncExternalStore } from 'react'
import {
  getDemoInputs,
  getHrRecording,
  getNodeLatest,
  getSettings,
  getSources,
  isUnreachable,
  type DemoInputs,
  type HrRecording,
  type NodeLatest,
  type SettingsResponse,
  type Sources,
} from './engineApi'

// Everything the views need from the engine besides a plan's simulation: the
// demo plan/roster/weather (/demo/inputs), AT-owned settings (/settings), cited
// constants (/sources: FHSAA zone rules, NATA, KSI) and the field node
// (/node/latest). Loaded once on app start.

export type EngineLink = 'loading' | 'online' | 'offline'

export interface EngineMeta {
  link: EngineLink
  inputs: DemoInputs | null
  settings: SettingsResponse | null
  sources: Sources | null
  node: NodeLatest | null
  /** v1.6: the real strap recording as calibration evidence (null when none). */
  hrRecording: HrRecording | null
  /** Non-fatal errors (one endpoint failed while the engine is up). */
  errors: string[]
}

let state: EngineMeta = { link: 'loading', inputs: null, settings: null, sources: null, node: null, hrRecording: null, errors: [] }
const listeners = new Set<() => void>()

function set(patch: Partial<EngineMeta>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

let loading: Promise<DemoInputs | null> | null = null

/** How often the web re-reads /node/latest (UI refresh rate, not a physiological value). */
const NODE_POLL_MS = 2000
let nodeTimer: ReturnType<typeof setInterval> | null = null

async function settle<T>(p: Promise<T>, what: string): Promise<T | null> {
  try {
    return await p
  } catch (e) {
    if (isUnreachable(e)) throw e
    set({ errors: [...state.errors, `${what}: ${(e as Error).message}`] })
    return null
  }
}

export const engineMeta = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,

  /** Fetch /demo/inputs, /settings, /sources and /node/latest. Resolves to the demo inputs (null when offline). */
  load(): Promise<DemoInputs | null> {
    if (loading) return loading
    loading = (async () => {
      set({ link: 'loading', errors: [] })
      try {
        const [inputs, settings, sources, node, hrRecording] = await Promise.all([
          settle(getDemoInputs(), '/demo/inputs'),
          settle(getSettings(), '/settings'),
          settle(getSources(), '/sources'),
          settle(getNodeLatest(), '/node/latest'),
          settle(getHrRecording(), '/validation/hr_recording'),
        ])
        set({ link: 'online', inputs, settings, sources, node, hrRecording })
        return inputs
      } catch (e) {
        if (!isUnreachable(e)) throw e
        set({ link: 'offline' })
        return null
      } finally {
        loading = null
      }
    })()
    return loading
  },

  /** Re-read the field node (it may start recording, or a tub probe may be wired, mid-demo). */
  async refreshNode() {
    try {
      set({ node: await getNodeLatest() })
    } catch {
      /* keep the last answer */
    }
  },

  /** Poll /node/latest so the sensor demo (heated globe) reaches the plan within a couple of seconds. */
  startNodePolling(everyMs = NODE_POLL_MS) {
    if (nodeTimer != null) return
    nodeTimer = setInterval(() => {
      if (state.link !== 'loading') void engineMeta.refreshNode()
    }, everyMs)
  },
  stopNodePolling() {
    if (nodeTimer != null) clearInterval(nodeTimer)
    nodeTimer = null
  },

  /** The engine answered a later call: it's up. */
  markOnline() {
    if (state.link !== 'online') set({ link: 'online' })
  },
  markOffline() {
    if (state.link !== 'offline') set({ link: 'offline' })
  },

  /** Tests only. */
  _reset(next: Partial<EngineMeta> = {}) {
    state = { link: 'loading', inputs: null, settings: null, sources: null, node: null, hrRecording: null, errors: [], ...next }
    loading = null
    listeners.forEach((fn) => fn())
  },
}

export function useEngineMeta(): EngineMeta {
  return useSyncExternalStore(engineMeta.subscribe, engineMeta.get)
}
