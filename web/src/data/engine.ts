import { useSyncExternalStore } from 'react'
import type { PracticePlan } from './llmPlan'
import { liveReplay, type LiveReplay, type SimulationResult, type WeatherHour } from './engineApi'
import {
  athleteAtMinute,
  drillAtMinute,
  firstFlagMinute,
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
// clock plays practice minutes back faster than wall time so a two-hour
// session plays in two minutes on stage. At each minute every number is read
// from the engine (selectors.ts); nothing is modelled here:
//   - POST /live/replay?demo=1 {plan} runs the HR file (fixtures/hr_*.csv; the
//     only one today is fixtures/hr_a07_synthetic.csv, labelled synthetic)
//     through the engine's live calibration. Athletes in the file read the
//     latest calibration frame at or before the minute (estimate, status,
//     gates); everyone else reads the plan forecast.
//   - Until the replay arrives (or if it fails) everyone reads /simulate.
//   - The HR file was recorded on the engine's demo plan (GET /demo/inputs).
//     It is replayed only while that plan is on screen; on any other plan
//     (optimized, edited, voice) calibrating against it is wrong (after
//     Optimize the a07 file read as met_scale ≈ 2 and a false crossing), so
//     everyone reads the plan forecast and Live / Athlete say why.
// When the engine is unreachable the stand-in's curves are used instead and
// every view badges them OFFLINE FALLBACK.

export type SessionSource = 'loading' | 'engine' | 'offline'

export interface ReplayInfo {
  /** `other_plan`: the plan on screen is not the one the HR file was recorded on — no replay. */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'other_plan'
  /** The HR file is synthetic (not a real athlete). */
  synthetic: boolean
  file: string | null
  /** Athletes with HR in the file. */
  athletes: string[]
  error: string | null
}

/** Plain-words provenance for the HR replay, shown on Coach, Athlete and the demo bar. */
export function replayLabel(r: ReplayInfo): string | null {
  if (r.status !== 'ready') return null
  const who = r.athletes.join(', ')
  return r.synthetic
    ? `replay of a synthetic HR file (${who}) — not a real athlete`
    : `replay of a recorded HR file (${r.file ?? who})`
}

/** Whether the HR replay belongs to the plan handed to the session (planStore decides, against /demo/inputs). */
export type ReplayFor = 'this_plan' | 'other_plan' | 'unknown'

/** The note Live and Athlete show while the HR replay is held back because another plan is on screen. */
export function replayHeldNote(r: ReplayInfo, planSource?: string): string | null {
  if (r.status !== 'other_plan') return null
  return planSource === 'optimized'
    ? 'The HR replay was recorded on the original plan — Undo optimization to watch it.'
    : 'The HR replay was recorded on the original plan — go back to the demo plan to watch it.'
}

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
  /** Provenance labels of the result the numbers come from (replay + plan forecast). */
  labels: string[]
  replay: ReplayInfo
  /** First minute the engine's gates flag anyone in the replay (for "skip ahead"). */
  firstFlagMinute: number | null
}

const EMIT_HZ = 12
/** Longest step one animation frame may take (a backgrounded tab doesn't jump the clock). */
const MAX_FRAME_S = 0.1

class Session {
  private plan: PracticePlan | null = null
  private sim: SimulationResult | null = null
  private replay: LiveReplay | null = null
  private replayInfo: ReplayInfo = { status: 'idle', synthetic: false, file: null, athletes: [], error: null }
  private replayAbort: AbortController | null = null
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
    this.rewind()
    this.publish()
  }

  /** Back to minute 0 without publishing (seek uses it to replay up to a point). */
  private rewind() {
    this.session++
    this.minute = 0
    this.publish()
  }

  /**
   * Today's plan and its /simulate result (null while the engine hasn't answered). `replayFor` says whether the HR
   * file belongs to this plan; only then is it replayed.
   */
  setPlan(plan: PracticePlan, sim: SimulationResult | null, replayFor: ReplayFor) {
    this.plan = plan
    this.sim = sim
    this.offline = null
    this.curves = sim ? makeCurveCache(sim.step_min, planMinutes(plan)) : null
    this.clearReplay()
    if (sim && replayFor === 'other_plan') this.replayInfo = { ...this.replayInfo, status: 'other_plan' }
    if (sim && replayFor === 'unknown')
      this.replayInfo = { ...this.replayInfo, status: 'error', error: "the engine's demo plan is unknown (GET /demo/inputs failed)" }
    this.reset()
    if (sim && replayFor === 'this_plan') void this.loadReplay(plan)
  }

  /** Engine unreachable: drive the screens from the stand-in (badged OFFLINE FALLBACK). */
  setOffline(plan: PracticePlan, offline: OfflineResult) {
    this.plan = plan
    this.sim = null
    this.offline = offline
    this.curves = null
    this.clearReplay()
    this.reset()
  }

  private clearReplay() {
    this.replayAbort?.abort()
    this.replayAbort = null
    this.replay = null
    this.replayInfo = { status: 'idle', synthetic: false, file: null, athletes: [], error: null }
  }

  /** POST /live/replay?demo=1 for this plan (deterministic and cached on the engine). */
  private async loadReplay(plan: PracticePlan) {
    const ctl = new AbortController()
    this.replayAbort = ctl
    this.replayInfo = { ...this.replayInfo, status: 'loading' }
    this.publish()
    try {
      const r = await liveReplay(plan, ctl.signal)
      if (ctl.signal.aborted || this.plan !== plan) return
      this.replay = r
      this.curves = makeCurveCache(r.plan_forecast.step_min, planMinutes(plan))
      this.replayInfo = {
        status: 'ready',
        synthetic: r.source.synthetic,
        file: r.source.file,
        athletes: r.source.athletes,
        error: null,
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || this.plan !== plan) return
      this.replay = null
      this.replayInfo = { status: 'error', synthetic: false, file: null, athletes: [], error: (e as Error).message }
    }
    this.publish()
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
      // The replay's plan_forecast is the prior it calibrates from; /simulate until it arrives.
      const forecast = this.replay?.plan_forecast ?? this.sim
      for (const a of forecast.athletes) {
        const live = athleteAtMinute({
          id: a.id,
          minute: this.minute,
          totalMin: total,
          plan: forecast,
          replay: this.replay,
          curves: this.curves ?? undefined,
        })
        if (live) athletes[a.id] = live
      }
      weather = weatherHourAt(forecast.weather, plan.start, this.minute)
      limitC = forecast.limit_core_c
      labels = this.replay ? [...new Set([...this.replay.labels, ...forecast.labels])] : forecast.labels
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
      replay: this.replayInfo,
      firstFlagMinute: firstFlagMinute(this.replay),
    }
    this.listeners.forEach((fn) => fn())
  }
}

export const engine = new Session()

export function useSession(): SessionState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}
