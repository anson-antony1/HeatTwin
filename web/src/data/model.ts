import type { Athlete, Drill, Gear, WeatherHour } from './types'
import { THRESHOLDS } from './constants'

// A stand-in for engine/physio/twonode.py so the UI has realistic shapes to
// draw. It is a single-node heat balance, tuned by eye — NOT the validated
// model. When /simulate is live, `simulate()` is the one function to replace.

const SPECIFIC_HEAT = 3490 // J/(kg·K), body tissue
const W_PER_MET = 58.2

const GEAR_EVAP: Record<Gear, number> = { none: 1.08, helmet: 1.0, shells: 0.84, full: 0.68 }

export function bodySurfaceArea(a: Pick<Athlete, 'massKg' | 'heightCm'>): number {
  // DuBois & DuBois (1916)
  return 0.007184 * Math.pow(a.massKg, 0.425) * Math.pow(a.heightCm, 0.725)
}

export function wbgtAt(forecast: WeatherHour[], hour: number): number {
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

export function totalMinutes(plan: Drill[]): number {
  return plan.reduce((s, d) => s + d.minutes, 0)
}

/** Drill active at a practice minute, plus its index and minutes left in it. */
export function drillAt(plan: Drill[], minute: number) {
  let t = 0
  for (let i = 0; i < plan.length; i++) {
    const d = plan[i]
    if (minute < t + d.minutes) return { drill: d, index: i, minuteLeft: t + d.minutes - minute, startsAt: t }
    t += d.minutes
  }
  const last = plan.length - 1
  return { drill: plan[last], index: last, minuteLeft: 0, startsAt: t - plan[last].minutes }
}

export function nextBreakIn(plan: Drill[], minute: number): number | null {
  let t = 0
  for (const d of plan) {
    if (d.kind === 'break' && t + d.minutes > minute) return Math.max(0, t - minute)
    t += d.minutes
  }
  return null
}

/** One minute of the heat balance. Returns the new core temperature. */
export function stepCore(
  coreC: number,
  athlete: Athlete,
  drill: Drill,
  wbgtF: number,
  heatFactor: number,
): number {
  const bsa = bodySurfaceArea(athlete)
  const produced = drill.met * W_PER_MET * bsa * heatFactor
  // Unacclimatized athletes sweat later and less (FHSAA's 14-day acclimatization period).
  const acclim = 0.6 + 0.4 * Math.min(athlete.acclimDay, 14) / 14
  // Hotter, more humid air (higher WBGT) leaves less room to shed heat.
  const environment = Math.max(0.12, Math.min(1.3, (100 - wbgtF) / 22))
  const rest = drill.kind === 'break' ? 1.35 : 1
  // Tuned (2026-10-03) so effort and heat both move core temp visibly: an hour at
  // max vs light effort differs by ~2 °C, and a real 82 °F-WBGT October day pushes
  // full-pads team periods past 38.5. Stand-in only — the engine's two-node model
  // is the real one.
  const lossCoeff = 280 // W/m² per °C above baseline
  const lost =
    bsa * (W_PER_MET * 1.15 + lossCoeff * Math.max(0, coreC - 36.8)) *
    GEAR_EVAP[drill.gear] * environment * acclim * rest
  const dT = ((produced - lost) * 60) / (athlete.massKg * SPECIFIC_HEAT)
  return Math.max(36.6, coreC + dT)
}

/** Minute-by-minute core temp forecast for a whole plan (length = minutes + 1). */
export function simulate(
  athlete: Athlete,
  plan: Drill[],
  forecast: WeatherHour[],
  startHour: number,
  heatFactor = 1,
  fromMinute = 0,
  fromCoreC: number = THRESHOLDS.baselineC,
): number[] {
  const total = totalMinutes(plan)
  const out: number[] = []
  let c = fromCoreC
  out.push(c)
  for (let m = fromMinute; m < total; m++) {
    const { drill } = drillAt(plan, m)
    c = stepCore(c, athlete, drill, wbgtAt(forecast, startHour + m / 60), heatFactor)
    out.push(c)
  }
  return out
}

/** p95 half-width: grows with horizon, tighter once HR has calibrated the model. */
export function bandFor(horizonMin: number, calibrated: boolean): number {
  const base = 0.06 + 0.024 * Math.sqrt(Math.max(0, horizonMin))
  return calibrated ? base * 0.55 : base
}

export function heartRate(athlete: Athlete, drill: Drill, coreC: number, noise: number): number {
  const intensity = Math.min(0.85, 0.12 + drill.met * 0.095)
  const thermalDrift = (coreC - THRESHOLDS.baselineC) * 9
  const hr = athlete.hrRest + (athlete.hrMax - athlete.hrRest) * intensity + thermalDrift + noise
  return Math.round(Math.max(athlete.hrRest, Math.min(athlete.hrMax, hr)))
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
