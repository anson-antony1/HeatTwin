import type { ContractDrill, PracticePlan } from '../data/llmPlan'
import { toUiDrills, type UiKind } from '../data/llmPlan'
import type { AthleteStatus, RosterAthlete, WeatherHour } from '../data/engineApi'
import type { AthleteLive } from '../data/selectors'
import { hourOf } from '../data/selectors'
import forecastFile from '../../../fixtures/forecast_2026-10-04.json'
import { peakOf, simulate, totalMinutes } from './model'
import { STAND_IN_THRESHOLDS } from './thresholds'
import type { StandInDrill, StandInWeatherHour } from './types'

// OFFLINE FALLBACK — not the validated model.
// Everything in this file exists only so the screens still draw something when
// the engine can't be reached. These literals are NOT sourced: they are the old
// browser stand-in's tuning. Every number produced here is shown with
// <OfflineBadge/> and an offline banner; nothing online imports this file.

export const OFFLINE_LABEL = 'OFFLINE FALLBACK — not the validated model'

/** Per-athlete heat factor the stand-in plan forecast uses. A literal table (no previous sessions exist). */
export const PRIOR_FACTOR: Record<string, number> = {
  a01: 1.27, a02: 1.06, a03: 1.03, a04: 1.01, a05: 0.97, a06: 1.0, a07: 1.02, a08: 0.98,
  a09: 0.96, a10: 0.98, a11: 0.95, a12: 1.0, a13: 0.98, a14: 0.96, a15: 0.93, a16: 1.05,
}

/** Metabolic rate per contract intensity, in PHS met units — stand-in values (the engine uses Compendium METs). */
export const MET_BY_INTENSITY: Record<ContractDrill['intensity'], number> = {
  rest: 1.4,
  light: 3.0,
  moderate: 4.6,
  hard: 5.3,
  max: 6.4,
}

export function contractToStandIn(plan: PracticePlan): StandInDrill[] {
  return toUiDrills(plan, (_kind: UiKind, d: ContractDrill) => d.met_override ?? MET_BY_INTENSITY[d.intensity])
}

/** The engine's own cached NWS fixture (fixtures/forecast_2026-10-04.json), read from disk — no network. */
export const OFFLINE_WEATHER: WeatherHour[] = (forecastFile as { hours: WeatherHour[] }).hours

function standInForecast(weather: WeatherHour[]): StandInWeatherHour[] {
  return weather.map((h) => ({ hour: hourOf(h.time) ?? 0, wbgtF: h.wbgt_f }))
}

function standInStatus(peak: number): AthleteStatus {
  if (peak >= STAND_IN_THRESHOLDS.alertC) return 'over_limit'
  if (peak >= STAND_IN_THRESHOLDS.watchC) return 'near_limit'
  return 'below_limit'
}

export interface OfflineAthlete {
  id: string
  name: string
  /** Stand-in core temperature, one value per minute 0…total. */
  curve: number[]
  peak: number
  peakMin: number
  status: AthleteStatus
}

export interface OfflineResult {
  offline: true
  minutes: number
  athletes: OfflineAthlete[]
  weather: WeatherHour[]
  limitC: number
  nearMarginC: number
  floorC: number
  labels: string[]
}

/** Stand-in forecast for a plan. OFFLINE FALLBACK ONLY. */
export function offlineSimulate(plan: PracticePlan, roster: RosterAthlete[]): OfflineResult {
  const drills = contractToStandIn(plan)
  const fc = standInForecast(OFFLINE_WEATHER)
  const start = hourOf(plan.start) ?? fc[0].hour
  const athletes = roster.map((a) => {
    const curve = simulate(
      { id: a.id, massKg: a.mass_kg, heightCm: a.height_m * 100, acclimDay: a.acclimatization_day },
      drills,
      fc,
      start,
      PRIOR_FACTOR[a.id] ?? 1,
    )
    const pk = peakOf(curve)
    return { id: a.id, name: a.name, curve, peak: pk.value, peakMin: pk.minute, status: standInStatus(pk.value) }
  })
  return {
    offline: true,
    minutes: totalMinutes(drills),
    athletes,
    weather: OFFLINE_WEATHER,
    limitC: STAND_IN_THRESHOLDS.alertC,
    nearMarginC: STAND_IN_THRESHOLDS.alertC - STAND_IN_THRESHOLDS.watchC,
    floorC: STAND_IN_THRESHOLDS.baselineC,
    labels: [OFFLINE_LABEL, 'in-browser stand-in model (tuned by eye)', 'forecast is fixture (cached NWS file)'],
  }
}

/** One athlete at a minute from the stand-in. No heart rate is generated: the offline view shows a plan curve only. */
export function offlineAthleteAt(res: OfflineResult, id: string, minute: number): AthleteLive | null {
  const a = res.athletes.find((x) => x.id === id)
  if (!a) return null
  const k = Math.max(0, Math.min(a.curve.length - 1, Math.floor(minute)))
  const zero = a.curve.map(() => 0)
  return {
    id,
    coreC: a.curve[k],
    p95C: a.curve[k],
    bandC: 0,
    peakP95C: a.peak,
    peakMin: a.peakMin,
    firstCrossMin: null,
    status: a.status,
    hr: null,
    hasHr: false,
    basis: 'offline',
    calibrated: false,
    flag: false,
    gates: null,
    history: a.curve.slice(0, k + 1),
    forecast: a.curve,
    band: zero,
  }
}
