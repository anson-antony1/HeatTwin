import type { StandInAthlete, StandInDrill, StandInGear, StandInWeatherHour } from './types'
import { STAND_IN_THRESHOLDS } from './thresholds'

// OFFLINE FALLBACK — not the validated model.
// A stand-in for engine/physio/twonode.py, used ONLY when the engine can't be
// reached. It is a single-node heat balance, tuned by eye. Every number drawn
// from it carries <OfflineBadge/>. The engine's two-node model is the only
// source of numbers when it is up.

const SPECIFIC_HEAT = 3490 // J/(kg·K), body tissue
const W_PER_MET = 58.2

const GEAR_EVAP: Record<StandInGear, number> = { none: 1.08, helmet: 1.0, shells: 0.84, full: 0.68 }

function bodySurfaceArea(a: Pick<StandInAthlete, 'massKg' | 'heightCm'>): number {
  // DuBois & DuBois (1916)
  return 0.007184 * Math.pow(a.massKg, 0.425) * Math.pow(a.heightCm, 0.725)
}

export function wbgtAt(forecast: StandInWeatherHour[], hour: number): number {
  if (hour <= forecast[0].hour) return forecast[0].wbgtF
  for (let i = 0; i < forecast.length - 1; i++) {
    const a = forecast[i]
    const b = forecast[i + 1]
    if (hour >= a.hour && hour <= b.hour) {
      const t = (hour - a.hour) / (b.hour - a.hour)
      return a.wbgtF + (b.wbgtF - a.wbgtF) * t
    }
  }
  return forecast[forecast.length - 1].wbgtF
}

export function totalMinutes(plan: StandInDrill[]): number {
  return plan.reduce((s, d) => s + d.minutes, 0)
}

function drillAt(plan: StandInDrill[], minute: number) {
  let t = 0
  for (const d of plan) {
    if (minute < t + d.minutes) return d
    t += d.minutes
  }
  return plan[plan.length - 1]
}

/** One minute of the stand-in heat balance. Returns the new core temperature. */
function stepCore(coreC: number, athlete: StandInAthlete, drill: StandInDrill, wbgtF: number, heatFactor: number): number {
  const bsa = bodySurfaceArea(athlete)
  const produced = drill.met * W_PER_MET * bsa * heatFactor
  const acclim = 0.72 + (0.28 * Math.min(athlete.acclimDay, 14)) / 14
  const environment = Math.max(0.12, Math.min(1.3, (97 - wbgtF) / 17))
  const rest = drill.kind === 'break' ? 1.35 : 1
  const lossCoeff = 520 // W/m² per °C above baseline, tuned
  const lost =
    bsa * (W_PER_MET * 1.15 + lossCoeff * Math.max(0, coreC - 36.8)) * GEAR_EVAP[drill.gear] * environment * acclim * rest
  const dT = ((produced - lost) * 60) / (athlete.massKg * SPECIFIC_HEAT)
  return Math.max(36.6, coreC + dT)
}

/** Minute-by-minute stand-in core temperature for a whole plan (length = minutes + 1). */
export function simulate(
  athlete: StandInAthlete,
  plan: StandInDrill[],
  forecast: StandInWeatherHour[],
  startHour: number,
  heatFactor = 1,
): number[] {
  const total = totalMinutes(plan)
  const out: number[] = []
  let c: number = STAND_IN_THRESHOLDS.baselineC
  out.push(c)
  for (let m = 0; m < total; m++) {
    c = stepCore(c, athlete, drillAt(plan, m), wbgtAt(forecast, startHour + m / 60), heatFactor)
    out.push(c)
  }
  return out
}

export function peakOf(series: number[]): { value: number; minute: number } {
  let value = -Infinity
  let minute = 0
  series.forEach((v, i) => {
    if (v > value) {
      value = v
      minute = i
    }
  })
  return { value, minute }
}
