import { useSyncExternalStore } from 'react'
import { DEFAULT_CONTRACT_PLAN } from './fixtures'

// App settings the coach owns. For now: the practice location, which drives
// the live weather (NWS via the engine) and the site every plan is modeled at.

export interface PracticeLocation {
  name: string
  /** e.g. "Alachua County, Florida, United States" */
  detail?: string
  lat: number
  lon: number
  source: 'default' | 'search' | 'gps'
}

export interface Settings {
  location: PracticeLocation
}

const KEY = 'heattwin.settings.v1'

const DEFAULT: Settings = {
  location: {
    name: DEFAULT_CONTRACT_PLAN.site.name,
    lat: DEFAULT_CONTRACT_PLAN.site.lat,
    lon: DEFAULT_CONTRACT_PLAN.site.lon,
    source: 'default',
  },
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    /* private mode / corrupt — use defaults */
  }
  return DEFAULT
}

let state: Settings = load()
const listeners = new Set<() => void>()

export const settingsStore = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,
  setLocation(location: PracticeLocation) {
    state = { ...state, location }
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      /* ignore */
    }
    listeners.forEach((fn) => fn())
  },
  resetLocation() {
    settingsStore.setLocation(DEFAULT.location)
  },
}

export function useSettings(): Settings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
}

export const DEFAULT_LOCATION = DEFAULT.location
