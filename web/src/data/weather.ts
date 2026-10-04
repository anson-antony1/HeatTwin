import { useSyncExternalStore } from 'react'
import { getWeather, type WeatherHour, type WeatherResponse } from './engineApi'
import { planStore } from './planStore'
import { weatherHourAt } from './selectors'

// Field conditions for a practice location the coach picks in Settings. The
// browser never fetches NWS or computes WBGT: the engine's GET /weather does
// (NWS hourly forecast + Liljegren WBGT + FHSAA zone per hour; the cached
// fixture, labelled, when NWS is unreachable). The place-name search below uses
// Open-Meteo's geocoder and shows no heat numbers.
// With no location picked, the field card shows the plan's own engine weather.

export interface WeatherLocation {
  name: string
  latitude: number
  longitude: number
}

interface WeatherState {
  location: WeatherLocation | null
  /** The engine's answer for `location`. */
  forecast: WeatherResponse | null
  /** Local date of the hours in `forecast.day` (the plan's date). */
  forecastDate: string | null
  phase: 'demo' | 'loading' | 'ready' | 'error'
  error: string | null
}

const STORAGE_KEY = 'heattwin.weather.v1'
let state: WeatherState = { location: null, forecast: null, forecastDate: null, phase: 'demo', error: null }
const listeners = new Set<() => void>()
let request: AbortController | null = null

function set(patch: Partial<WeatherState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

async function json<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Location search returned ${response.status}.`)
  return response.json() as Promise<T>
}

/** Place-name search (Open-Meteo geocoder). Names and coordinates only. */
export async function searchWeatherLocations(query: string, signal?: AbortSignal): Promise<WeatherLocation[]> {
  const term = query.trim()
  if (term.length < 2) return []
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
  url.searchParams.set('name', term)
  url.searchParams.set('count', '8')
  url.searchParams.set('countryCode', 'US')
  const result = await json<{ results?: { name: string; admin1?: string; latitude: number; longitude: number }[] }>(url.toString(), signal ?? AbortSignal.timeout(15_000))
  return (result.results ?? []).map((item) => ({
    name: [item.name, item.admin1].filter(Boolean).join(', '),
    latitude: item.latitude,
    longitude: item.longitude,
  }))
}

/** The plan's local date ("2026-10-04"), so the engine returns that day's hours. */
function planDate(): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(planStore.get().plan.start)
  return m ? m[1] : null
}

export const weatherStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  get: () => state,
  async select(location: WeatherLocation) {
    request?.abort()
    request = new AbortController()
    set({ phase: 'loading', error: null })
    try {
      const date = planDate()
      const forecast = await getWeather(location.latitude, location.longitude, date, request.signal)
      if (!forecast.now && !forecast.day.length) throw new Error('The engine has no forecast for this location.')
      set({ location, forecast, forecastDate: forecast.day[0]?.time.slice(0, 10) ?? null, phase: 'ready', error: null })
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(location)) } catch { /* private storage */ }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') set({ phase: 'error', error: (error as Error).message })
    }
  },
  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WeatherLocation | null
      if (saved && typeof saved.latitude === 'number' && typeof saved.longitude === 'number') void this.select(saved)
    } catch { /* plan weather */ }
  },
}

export function useWeather() {
  return useSyncExternalStore(weatherStore.subscribe, weatherStore.get)
}

/**
 * The engine hour the field card shows: for a location picked in Settings, the engine /weather hour at the practice
 * clock on the plan's date (else its current hour); otherwise the plan's own engine weather hour (`planHour`).
 */
export function fieldHour(
  w: Pick<WeatherState, 'location' | 'forecast'>,
  planHour: WeatherHour | null,
  startIso: string | null,
  minute: number,
): WeatherHour | null {
  if (w.location && w.forecast) {
    return (startIso ? weatherHourAt(w.forecast.day, startIso, minute) : null) ?? w.forecast.now
  }
  return planHour
}
