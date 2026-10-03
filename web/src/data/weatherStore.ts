import { useSyncExternalStore } from 'react'
import type { WeatherHour, Zone } from './types'
import { FORECAST } from './fixtures'
import { ZONES } from './constants'
import { settingsStore, type PracticeLocation } from './settingsStore'

// Live conditions for the practice location, from the engine's GET /weather
// (WS1: NWS hourly forecast + Liljegren WBGT + FHSAA zone per hour). Polled
// every 10 minutes and whenever the location changes. Falls back to the
// labelled fixture when NWS is unreachable or the site is outside the US.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'
const POLL_MS = 10 * 60 * 1000

/** One hour as the engine returns it (CONTRACTS.md WeatherHour). */
export interface EngineHour {
  time: string
  air_temp_c: number
  rh_pct: number
  wind_m_s: number
  cloud_cover_pct: number
  solar_w_m2?: number
  wbgt_f: number
  fhsaa_zone: 1 | 2 | 3 | 4 | 5
  source: string
  nws_wbgt_f?: number
}

export interface WeatherState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  location: PracticeLocation
  place: string | null
  source: 'nws_forecast' | 'fixture' | 'none' | null
  now: EngineHour | null
  next: EngineHour[]
  /** Hours on the plan's date, for the replay and the plan view. */
  day: EngineHour[]
  fetchedAt: number | null
  error: string | null
}

let state: WeatherState = {
  status: 'idle',
  location: settingsStore.get().location,
  place: null,
  source: null,
  now: null,
  next: [],
  day: [],
  fetchedAt: null,
  error: null,
}

const listeners = new Set<() => void>()
const dayListeners = new Set<(hours: WeatherHour[]) => void>()
let planDate = '2026-10-04'
let timer: number | null = null
let inflight: AbortController | null = null

function set(patch: Partial<WeatherState>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

export const cToF = (c: number) => c * 1.8 + 32
export const msToMph = (m: number) => m * 2.23694

/** WS1's FHSAA zone number (verified against the 2025-26 handbook) → the UI's zone. */
export function zoneOf(n: number): Zone {
  return ZONES[Math.max(0, Math.min(ZONES.length - 1, n - 1))]
}

/** Engine hours → the replay's WeatherHour shape (keyed by local hour of day). */
export function toReplayHours(hours: EngineHour[]): WeatherHour[] {
  return hours.map((h) => ({
    hour: Number(h.time.slice(11, 13)),
    tempF: cToF(h.air_temp_c),
    rh: h.rh_pct,
    windMph: msToMph(h.wind_m_s),
    wbgtF: h.wbgt_f,
    source: 'forecast',
  }))
}

async function refresh() {
  const loc = settingsStore.get().location
  inflight?.abort()
  inflight = new AbortController()
  set({ status: state.now && sameLoc(state.location, loc) ? 'ready' : 'loading', location: loc, error: null })
  try {
    const q = new URLSearchParams({ lat: loc.lat.toFixed(4), lon: loc.lon.toFixed(4), date: planDate })
    const r = await fetch(`${ENGINE}/weather?${q}`, {
      signal: AbortSignal.any([inflight.signal, AbortSignal.timeout(30_000)]),
    })
    if (!r.ok) throw new Error(`Weather HTTP ${r.status}`)
    const d = await r.json()
    set({
      status: 'ready',
      place: d.place ?? null,
      source: d.source,
      now: d.now,
      next: d.next_hours ?? [],
      day: d.day ?? [],
      fetchedAt: Date.now(),
    })
    const live = d.source === 'nws_forecast' && (d.day?.length ?? 0) >= 6
    const replay = live ? toReplayHours(d.day) : FORECAST
    dayListeners.forEach((fn) => fn(replay))
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    set({ status: 'error', error: "Can't reach the engine for weather." })
  }
}

function sameLoc(a: PracticeLocation, b: PracticeLocation) {
  return a.lat === b.lat && a.lon === b.lon
}

export const weatherStore = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,
  refresh,
  /** Start polling. Re-fetches when the location changes. Returns a stop function. */
  start() {
    refresh()
    timer = window.setInterval(refresh, POLL_MS)
    const unsub = settingsStore.subscribe(() => {
      if (!sameLoc(settingsStore.get().location, state.location)) refresh()
    })
    return () => {
      if (timer != null) window.clearInterval(timer)
      unsub()
      inflight?.abort()
    }
  },
  /** The plan's date decides which day's hours feed the replay. */
  setPlanDate(date: string) {
    if (date === planDate) return
    planDate = date
    refresh()
  },
  /** Called with the replay forecast (live day, or the fixture) after every fetch. */
  onDayForecast(fn: (hours: WeatherHour[]) => void) {
    dayListeners.add(fn)
    return () => dayListeners.delete(fn)
  },
}

export function useWeather(): WeatherState {
  return useSyncExternalStore(weatherStore.subscribe, weatherStore.get)
}
