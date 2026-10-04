import { useSyncExternalStore } from 'react'
import {
  getDemoInputs,
  getNodeLatest,
  getSettings,
  getSources,
  isUnreachable,
  type DemoInputs,
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
  /** Non-fatal errors (one endpoint failed while the engine is up). */
  errors: string[]
}

let state: EngineMeta = { link: 'loading', inputs: null, settings: null, sources: null, node: null, errors: [] }
const listeners = new Set<() => void>()

function set(patch: Partial<EngineMeta>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

let loading: Promise<DemoInputs | null> | null = null

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
        const [inputs, settings, sources, node] = await Promise.all([
          settle(getDemoInputs(), '/demo/inputs'),
          settle(getSettings(), '/settings'),
          settle(getSources(), '/sources'),
          settle(getNodeLatest(), '/node/latest'),
        ])
        set({ link: 'online', inputs, settings, sources, node })
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

  /** The engine answered a later call: it's up. */
  markOnline() {
    if (state.link !== 'online') set({ link: 'online' })
  },
  markOffline() {
    if (state.link !== 'offline') set({ link: 'offline' })
  },

  /** Tests only. */
  _reset(next: Partial<EngineMeta> = {}) {
    state = { link: 'loading', inputs: null, settings: null, sources: null, node: null, errors: [], ...next }
    loading = null
    listeners.forEach((fn) => fn())
  },
}

export function useEngineMeta(): EngineMeta {
  return useSyncExternalStore(engineMeta.subscribe, engineMeta.get)
}
