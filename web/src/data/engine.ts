import { useSyncExternalStore } from 'react'
import type { PracticePlan } from './llmPlan'
import type { SimulationResult, WeatherHour } from './engineApi'
import {
  athleteAtMinute,
  drillAtMinute,
  hourOf,
  makeCurveCache,
  nextBreakIn,
  planMinutes,
  weatherHourAt,
  type AthleteLive,
  type CurveCache,
} from './selectors'
import { offlineAthleteAt, type OfflineResult } from '../offline/standIn'

// The demo session: a playback clock over today's plan. It is NOT live — the
// clock replays practice minutes faster than wall time so a two-hour session
// plays in two minutes on stage. At each minute every number is read from the
// engine's result for the plan (selectors.ts); nothing is modelled here.
// When the engine is unreachable the stand-in's curves are used instead and
// every view badges them OFFLINE FALLBACK.

export type SessionSource = 'loading' | 'engine' | 'offline'

export interface SessionState {
  /** Increments on every reset / plan change, so UI state can key off a run. */
  session: number
  /** Fractional practice minute since start (demo playback clock). */
  minute: number
  totalMinutes: number
  /** Plan start as a local wall-clock hour (from the plan's ISO start). */
  startHour: number
  plan: PracticePlan | null
  drillIndex: number
  drillMinuteLeft: number
  nextBreakIn: number | null
  running: boolean
  speed: number
  source: SessionSource
  athletes: Record<string, AthleteLive>
  /** The engine's forecast hour containing this minute (WBGT, FHSAA zone). */
  weather: WeatherHour | null
  /** Planning line the numbers are judged against (result `limit_core_c`). */
  limitC: number | null
  /** Provenance labels of the result the numbers come from. */
  labels: string[]
}

const EMIT_HZ = 12
/** Longest step one animation frame may take (a backgrounded tab doesn't jump the clock). */
const MAX_FRAME_S = 0.1

class Session {
  private plan: PracticePlan | null = null
  private sim: SimulationResult | null = null
  private offline: OfflineResult | null = null
  private curves: CurveCache | null = null
  private minute = 0
  private running = false
  private speed = 1
  private last = 0
  private sinceEmit = 0
  private raf = 0
  private listeners = new Set<() => void>()
  private snapshot!: SessionState
  private session = 0

  constructor() {
    this.publish()
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = () => this.snapshot

  private get total() {
    return this.plan ? planMinutes(this.plan) : 0
  }

  reset() {
    this.session++
    this.minute = 0
    this.publish()
  }

  /** Today's plan and its /simulate result (null while the engine hasn't answered). */
  setPlan(plan: PracticePlan, sim: SimulationResult | null) {
    this.plan = plan
    this.sim = sim
    this.offline = null
    this.curves = sim ? makeCurveCache(sim.step_min, planMinutes(plan)) : null
    this.reset()
  }

  /** Engine unreachable: drive the screens from the stand-in (badged OFFLINE FALLBACK). */
  setOffline(plan: PracticePlan, offline: OfflineResult) {
    this.plan = plan
    this.sim = null
    this.offline = offline
    this.curves = null
    this.reset()
  }

  play() {
    if (this.running || !this.plan) return
    if (this.minute >= this.total) this.minute = 0
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

  /** Jump the playback clock (demo control). */
  seek(toMinute: number) {
    this.minute = Math.max(0, Math.min(toMinute, this.total))
    this.publish()
  }

  private frame = (now: number) => {
    const dt = Math.min(MAX_FRAME_S, (now - this.last) / 1000)
    this.last = now
    const total = this.total
    this.minute = Math.min(total, this.minute + dt * this.speed)
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

  private publish() {
    const plan = this.plan
    const total = this.total
    const at = plan ? drillAtMinute(plan.drills, this.minute) : null
    const athletes: Record<string, AthleteLive> = {}
    let weather: WeatherHour | null = null
    let limitC: number | null = null
    let labels: string[] = []
    let source: SessionSource = 'loading'

    if (plan && this.sim) {
      source = 'engine'
      for (const a of this.sim.athletes) {
        const live = athleteAtMinute({
          id: a.id,
          minute: this.minute,
          totalMin: total,
          plan: this.sim,
          replay: null,
          curves: this.curves ?? undefined,
        })
        if (live) athletes[a.id] = live
      }
      weather = weatherHourAt(this.sim.weather, plan.start, this.minute)
      limitC = this.sim.limit_core_c
      labels = this.sim.labels
    } else if (plan && this.offline) {
      source = 'offline'
      for (const a of this.offline.athletes) {
        const live = offlineAthleteAt(this.offline, a.id, this.minute)
        if (live) athletes[a.id] = live
      }
      weather = weatherHourAt(this.offline.weather, plan.start, this.minute)
      limitC = this.offline.limitC
      labels = this.offline.labels
    }

    this.snapshot = {
      session: this.session,
      minute: this.minute,
      totalMinutes: total,
      startHour: plan ? (hourOf(plan.start) ?? 0) : 0,
      plan,
      drillIndex: at?.index ?? 0,
      drillMinuteLeft: at?.minuteLeft ?? 0,
      nextBreakIn: plan ? nextBreakIn(plan.drills, this.minute) : null,
      running: this.running,
      speed: this.speed,
      source,
      athletes,
      weather,
      limitC,
      labels,
    }
    this.listeners.forEach((fn) => fn())
  }
}

export const engine = new Session()

export function useSession(): SessionState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}
