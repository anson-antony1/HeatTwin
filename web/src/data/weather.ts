import { useSyncExternalStore } from 'react'
import { engine } from './engine'
import { FORECAST, PRACTICE_START_HOUR } from './fixtures'
import type { WeatherHour } from './types'

export interface WeatherLocation {
  name: string
  latitude: number
  longitude: number
}

interface WeatherState {
  location: WeatherLocation | null
  forecast: WeatherHour[]
  forecastDate: string | null
  phase: 'demo' | 'loading' | 'ready' | 'error'
  error: string | null
}

interface GridSeries {
  uom?: string
  values?: { validTime: string; value: number | null }[]
}

const STORAGE_KEY = 'heattwin.weather.v1'
let state: WeatherState = { location: null, forecast: FORECAST, forecastDate: null, phase: 'demo', error: null }
const listeners = new Set<() => void>()
let request: AbortController | null = null

function set(patch: Partial<WeatherState>) {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

async function json<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, headers: { Accept: 'application/geo+json, application/json' } })
  if (!response.ok) throw new Error(`Weather service returned ${response.status}.`)
  return response.json() as Promise<T>
}

function localKey(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return `${part('year')}-${part('month')}-${part('day')}:${part('hour')}`
}

function hourly(series: GridSeries | undefined, timeZone: string) {
  const values = new Map<string, number>()
  for (const item of series?.values ?? []) {
    if (item.value == null || !Number.isFinite(item.value)) continue
    const [startText, duration = 'PT1H'] = item.validTime.split('/')
    const start = Date.parse(startText)
    if (!Number.isFinite(start)) continue
    const days = Number(duration.match(/(\d+)D/)?.[1] ?? 0)
    const hours = Number(duration.match(/(\d+)H/)?.[1] ?? 0)
    const count = Math.max(1, Math.min(168, days * 24 + hours))
    for (let i = 0; i < count; i++) values.set(localKey(new Date(start + i * 3_600_000), timeZone), item.value)
  }
  return values
}

function nearest(values: Map<string, number>, date: string, hour: number): number | null {
  const exact = values.get(`${date}:${String(hour).padStart(2, '0')}`)
  if (exact != null) return exact
  for (let distance = 1; distance < 24; distance++) {
    for (const h of [hour - distance, hour + distance]) {
      if (h < 0 || h > 23) continue
      const value = values.get(`${date}:${String(h).padStart(2, '0')}`)
      if (value != null) return value
    }
  }
  return null
}

function fahrenheit(value: number, uom?: string) {
  return uom?.includes('degF') ? value : value * 9 / 5 + 32
}

function mph(value: number, uom?: string) {
  if (uom?.includes('mph')) return value
  if (uom?.includes('km_h-1')) return value / 1.609344
  return value * 2.236936 // NWS default m/s
}

async function fetchForecast(location: WeatherLocation, signal: AbortSignal) {
  const point = await json<{ properties?: { forecastGridData?: string; timeZone?: string } }>(
    `https://api.weather.gov/points/${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`, signal,
  )
  const gridUrl = point.properties?.forecastGridData
  const timeZone = point.properties?.timeZone
  if (!gridUrl || !timeZone) throw new Error('No NWS forecast grid is available for this location.')
  const grid = await json<{ properties?: Record<string, unknown> }>(gridUrl, signal)
  const properties = grid.properties ?? {}
  const get = (key: string) => properties[key] as GridSeries | undefined
  const wbgtSeries = get('wetBulbGlobeTemperature')
  const wbgt = hourly(wbgtSeries, timeZone)
  const dates = [...new Set([...wbgt.keys()].filter((key) => key.endsWith(':15')).map((key) => key.slice(0, 10)))].sort()
  const localNow = localKey(new Date(), timeZone)
  const today = localNow.slice(0, 10)
  // The fixed replay starts at 3:30 PM. Once that start has passed, use the
  // next practice day's forecast instead of replaying weather from this morning.
  const practiceStarted = Number(localNow.slice(-2)) >= Math.ceil(PRACTICE_START_HOUR)
  const date = dates.find((candidate) => candidate > today || (candidate === today && !practiceStarted))
  if (!date) throw new Error('The NWS has no upcoming WBGT forecast for this location.')
  const tempSeries = get('temperature')
  const windSeries = get('windSpeed')
  const temp = hourly(tempSeries, timeZone)
  const humidity = hourly(get('relativeHumidity'), timeZone)
  const wind = hourly(windSeries, timeZone)
  const forecast: WeatherHour[] = Array.from({ length: 24 }, (_, hour) => {
    const wbgtC = nearest(wbgt, date, hour)
    if (wbgtC == null) throw new Error('The NWS WBGT forecast has gaps for this practice day.')
    const tempC = nearest(temp, date, hour)
    const windValue = nearest(wind, date, hour)
    return {
      hour,
      wbgtF: fahrenheit(wbgtC, wbgtSeries?.uom),
      tempF: tempC == null ? fahrenheit(wbgtC, wbgtSeries?.uom) : fahrenheit(tempC, tempSeries?.uom),
      rh: nearest(humidity, date, hour) ?? 50,
      windMph: windValue == null ? 0 : mph(windValue, windSeries?.uom),
      source: 'nws_forecast',
    }
  })
  return { forecast, date }
}

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
      const { forecast, date } = await fetchForecast(location, request.signal)
      set({ location, forecast, forecastDate: date, phase: 'ready', error: null })
      engine.setWeather(forecast)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(location)) } catch { /* private storage */ }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') set({ phase: 'error', error: (error as Error).message })
    }
  },
  restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as WeatherLocation | null
      if (saved && typeof saved.latitude === 'number' && typeof saved.longitude === 'number') void this.select(saved)
    } catch { /* use demo forecast */ }
  },
}

export function useWeather() {
  return useSyncExternalStore(weatherStore.subscribe, weatherStore.get)
}
