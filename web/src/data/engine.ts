import { useSyncExternalStore } from 'react'
import type { Athlete, AthleteLive, Drill, SessionState, Status, WeatherHour } from './types'
import { THRESHOLDS, zoneFor } from './constants'
import { FORECAST, PLAN, PRACTICE_START_HOUR, ROSTER, TRUE_HEAT_FACTOR } from './fixtures'
import { bandFor, drillAt, heartRate, nextBreakIn, peakOf, simulate, stepCore, totalMinutes, wbgtAt } from './model'
import { PRIOR_FACTOR } from './optimizer'
import { perMinute, type SimulationResult } from './engineApi'

// The live loop. Stands in for the Watch layer: a strap broadcasts HR once a
// second, the estimate is corrected toward what HR implies, and the rest of the
// session is re-forecast. Demo time runs faster than wall time (`speed` practice
// minutes per real second). Swap `advanceMinute` for a websocket feed later.
//
// Two forecast sources:
//   'engine' — a confirmed plan's /simulate result. Each athlete's p50 curve is
//              the plan forecast; live HR corrects around it; p95 − p50 is the band.
//   'replay' — no engine result yet: the browser-side stand-in model (model.ts).

interface Track {
  athlete: Athlete
  /** Physics-propagated estimate, corrected by HR each minute. */
  est: number
  /** What the athlete's body is actually doing (hidden; drives the fake HR). */
  truth: number
  /** Heat factor the filter currently believes. */
  factor: number
  history: number[]
  hrHistory: number[]
  pending: number
  minutesOverLine: number
  /** Latched alert (persistence to raise, hysteresis to clear). */
  alerted: boolean
}

const EMIT_HZ = 12
const BASE = THRESHOLDS.baselineC

interface EngineSeries {
  p50: number[]
  p95: number[]
}

function noise(seed: number) {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return (x - Math.floor(x)) * 2 - 1
}

class Engine {
  private plan: Drill[] = PLAN
  private tracks: Track[] = []
  private minute = 0
  private running = false
  private speed = 1
  private last = 0
  private sinceEmit = 0
  private raf = 0
  private listeners = new Set<() => void>()
  private snapshot!: SessionState
  private session = 0
  private ext: Record<string, EngineSeries> | null = null
  /** Hourly WBGT for the plan's day: the live NWS forecast when available, else the fixture. */
  private forecast: WeatherHour[] = FORECAST

  constructor() {
    this.reset()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  reset() {
    this.rewind()
    this.publish()
  }

  /** Back to minute 0 without publishing (seek uses it to replay up to a point). */
  private rewind() {
    this.session++
    this.minute = 0
    this.tracks = ROSTER.map((athlete) => {
      const t: Track = {
        athlete,
        est: THRESHOLDS.baselineC,
        truth: THRESHOLDS.baselineC,
        // Engine curves are already per-athlete calibrated; the replay model needs its prior.
        factor: this.ext ? 1 : (PRIOR_FACTOR[athlete.id] ?? 1),
        history: [THRESHOLDS.baselineC],
        hrHistory: [athlete.hrRest],
        pending: THRESHOLDS.baselineC,
        minutesOverLine: 0,
        alerted: false,
      }
      t.pending = this.project(t, 0)
      return t
    })
  }

  /** Swap today's plan. Pass the plan's /simulate result to drive forecasts from the engine. */
  setPlan(plan: Drill[], sim?: SimulationResult | null) {
    this.plan = plan
    const minutes = totalMinutes(plan)
    this.ext = sim
      ? Object.fromEntries(
          sim.athletes.map((a) => [
            a.id,
            { p50: perMinute(a.core_c_p50, sim.step_min, minutes), p95: perMinute(a.core_c_p95, sim.step_min, minutes) },
          ]),
        )
      : null
    this.reset()
  }

  /** Swap in a new day forecast (live weather arrived or the location changed). */
  setForecast(hours: WeatherHour[]) {
    if (JSON.stringify(hours) === JSON.stringify(this.forecast)) return
    this.forecast = hours
    const at = this.minute
    this.rewind()
    this.seek(at) // replay to the same minute under the new weather
  }

  get currentForecast() {
    return this.forecast
  }

  play() {
    if (this.running) return
    if (this.minute >= totalMinutes(this.plan)) this.reset()
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.publish()
  }

  pause() {
    this.running = false
    cancelAnimationFrame(this.raf)
    this.publish()
  }

  setSpeed(speed: number) {
    this.speed = speed
    this.publish()
  }

  /**
   * Jump to any practice minute (demo scrubbing). Going back replays the
   * session from the start up to the target — deterministic, so the same minute
   * always shows the same state — and clears acknowledgements so alerts can be
   * shown again.
   */
  seek(toMinute: number) {
    const target = Math.max(0, Math.min(toMinute, totalMinutes(this.plan)))
    if (Math.floor(target) < Math.floor(this.minute)) this.rewind()
    for (let m = Math.floor(this.minute); m < Math.floor(target); m++) this.advanceMinute(m)
    this.minute = target
    this.publish()
  }

  private frame = (now: number) => {
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    const total = totalMinutes(this.plan)
    const before = Math.floor(this.minute)
    this.minute = Math.min(total, this.minute + dt * this.speed)
    for (let m = before; m < Math.floor(this.minute); m++) this.advanceMinute(m)

    this.sinceEmit += dt
    if (this.sinceEmit >= 1 / EMIT_HZ || this.minute >= total) {
      this.sinceEmit = 0
      this.publish()
    }
    if (this.minute >= total) {
      this.running = false
      this.publish()
      return
    }
    this.raf = requestAnimationFrame(this.frame)
  }

  /** Next-minute estimate from physics alone (the time update). */
  private project(t: Track, m: number) {
    const e = this.ext?.[t.athlete.id]
    if (e) return t.est + (at(e.p50, m + 1) - at(e.p50, m)) * t.factor
    const { drill } = drillAt(this.plan, m)
    return stepCore(t.est, t.athlete, drill, wbgtAt(this.forecast, PRACTICE_START_HOUR + m / 60), t.factor)
  }

  /** Close out practice minute `m` (0-based) for every athlete. */
  private advanceMinute(m: number) {
    const { drill } = drillAt(this.plan, m)
    const wbgt = wbgtAt(this.forecast, PRACTICE_START_HOUR + m / 60)
    for (const t of this.tracks) {
      const e = this.ext?.[t.athlete.id]
      if (e) {
        // How far this athlete's body runs from the engine's plan forecast.
        const dev = (TRUE_HEAT_FACTOR[t.athlete.id] ?? 1) / (PRIOR_FACTOR[t.athlete.id] ?? 1)
        t.truth = BASE + (at(e.p50, m + 1) - BASE) * dev
      } else {
        t.truth = stepCore(t.truth, t.athlete, drill, wbgt, TRUE_HEAT_FACTOR[t.athlete.id] ?? 1)
      }
      const physics = t.pending
      if (t.athlete.hasStrap) {
        // Observation update: HR says the body is at `truth` (+ sensor noise).
        const observed = t.truth + noise(m * 7.1 + t.athlete.number) * 0.04
        const innovation = observed - physics
        t.est = physics + 0.45 * innovation
        // Slowly learn this athlete's heat factor from the gap.
        t.factor += (this.ext ? 1.2 : 0.9) * innovation
        t.factor = Math.max(0.8, Math.min(1.6, t.factor))
        t.hrHistory.push(heartRate(t.athlete, drill, t.truth, noise(m * 3.3 + t.athlete.number) * 2))
      } else {
        t.est = physics
      }
      t.history.push(t.est)
      t.minutesOverLine = t.est >= THRESHOLDS.alertC ? t.minutesOverLine + 1 : 0
      if (t.minutesOverLine >= THRESHOLDS.persistMin) t.alerted = true
      else if (t.est < THRESHOLDS.alertC - THRESHOLDS.clearBelowC) t.alerted = false
      t.pending = this.project(t, m + 1)
    }
  }

  private publish() {
    const total = totalMinutes(this.plan)
    const k = Math.floor(this.minute)
    const frac = this.minute - k
    const { index, minuteLeft } = drillAt(this.plan, this.minute)
    const wbgtF = wbgtAt(this.forecast, PRACTICE_START_HOUR + this.minute / 60)

    const athletes: Record<string, AthleteLive> = {}
    for (const t of this.tracks) {
      const coreC = k >= total ? t.est : t.est + (t.pending - t.est) * frac
      const calibrated = t.athlete.hasStrap && k > 5
      const e = this.ext?.[t.athlete.id]
      let rest: number[]
      let band: number[]
      if (e) {
        // Re-forecast: the engine's remaining curve, re-anchored on the live estimate.
        rest = e.p50.slice(k).map((v) => t.est + (v - at(e.p50, k)) * t.factor)
        band = [
          ...Array<number>(k).fill(0),
          ...e.p95.slice(k).map((v, i) => (i === 0 ? 0 : (v - e.p50[k + i]) * (calibrated ? 0.6 : 1))),
        ]
      } else {
        rest = simulate(t.athlete, this.plan, this.forecast, PRACTICE_START_HOUR, t.factor, k, t.est)
        band = Array.from({ length: k + rest.length }, (_, i) => (i <= k ? 0 : bandFor(i - k, calibrated)))
      }
      const forecast = [...t.history.slice(0, k), ...rest]
      const peak = peakOf(forecast)
      let status: Status = 'steady'
      if (coreC >= THRESHOLDS.watchC || peak.value >= THRESHOLDS.alertC) status = 'watch'
      if (t.alerted) status = 'alert'
      athletes[t.athlete.id] = {
        id: t.athlete.id,
        coreC,
        hr: t.athlete.hasStrap ? (t.hrHistory[t.hrHistory.length - 1] ?? null) : null,
        history: t.history.slice(0, k + 1),
        forecast,
        band,
        predictedPeakC: peak.value,
        predictedPeakMin: peak.minute,
        status,
        minutesOverLine: t.minutesOverLine,
      }
    }

    this.snapshot = {
      session: this.session,
      minute: this.minute,
      totalMinutes: total,
      startHour: PRACTICE_START_HOUR,
      drillIndex: index,
      drillMinuteLeft: minuteLeft,
      nextBreakIn: nextBreakIn(this.plan, this.minute),
      wbgtF,
      zone: zoneFor(wbgtF),
      athletes,
      running: this.running,
      speed: this.speed,
      forecastSource: this.ext ? 'engine' : 'replay',
    }
    this.listeners.forEach((fn) => fn())
  }

  get currentPlan() {
    return this.plan
  }
}

function at(arr: number[], i: number) {
  return arr[Math.max(0, Math.min(arr.length - 1, i))]
}

export const engine = new Engine()

export function useSession(): SessionState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}

export function usePlan(): Drill[] {
  useSession()
  return engine.currentPlan
}
