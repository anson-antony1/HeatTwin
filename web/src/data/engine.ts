import { useSyncExternalStore } from 'react'
import type { PracticePlan } from './llmPlan'
import { liveReplay, type LiveReplay, type SimulationResult, type WeatherHour } from './engineApi'
import { DEFAULT_CONTRACT_PLAN } from './fixtures'
import { liveApplies, liveLabel, liveStore } from './liveStore'
import {
  athleteAtMinute,
  athleteFromLive,
  chartDrills,
  drillAtMinute,
  firstCrossing,
  firstEstimateCrossing,
  firstFlagMinute,
  hourOf,
  makeCurveCache,
  nextBreakIn,
  offlineAthlete,
  planMinutes,
  replaySourceLabel,
  weatherHourAt,
  type AthleteLive,
  type ChartDrill,
  type CurveCache,
} from './selectors'

// The demo session: a playback clock over today's plan. It is NOT live — the
// clock plays practice minutes back faster than wall time so a two-hour session
// plays in two minutes on stage. At each minute every number is read from the
// engine (selectors.ts); nothing is modelled here:
//   - POST /live/replay?demo=1 {plan} runs the HR file (fixtures/hr_*.csv) through
//     the engine's live calibration. Athletes in the file read the latest
//     calibration frame at or before the minute (estimate, status, gates);
//     everyone else reads the plan forecast.
//   - Until the replay arrives (or if it fails) everyone reads /simulate.
//   - The HR file was recorded on the engine's demo plan (GET /demo/inputs). It
//     is replayed only while that plan is on screen; on any other plan everyone
//     reads the plan forecast and the screens say why.
// Live HR (GET /live/state, polled by liveStore): while a strap is being
// received on the plan on screen, the views follow the wall clock (`minute`
// from the engine), mapped athletes show their strap HR and the engine's
// re-forecast, everyone else the session's `reforecast`; labelled
// "live · <device>". Otherwise the demo playback above.
// When the engine is unreachable there are no numbers at all: the screens keep
// the plan structure, show "—" and the "offline fallback" badge.

export type SessionSource = 'loading' | 'engine' | 'offline'

export interface ReplayInfo {
  /** `other_plan`: the plan on screen is not the one the HR file was recorded on — no replay. */
  status: 'idle' | 'loading' | 'ready' | 'error' | 'other_plan'
  /** The HR file is synthetic (not a real athlete). */
  synthetic: boolean
  /** Engine provenance label: "replay · <date> · <device>" / "replay · synthetic HR file (not a real athlete)". */
  label: string | null
  file: string | null
  /** Athletes with HR in the file. */
  athletes: string[]
  error: string | null
}

/** Whether the HR replay belongs to the plan handed to the session (planStore decides, against /demo/inputs). */
export type ReplayFor = 'this_plan' | 'other_plan' | 'unknown'

/** The note Live and Athlete show while the HR replay is held back because another plan is on screen. */
export function replayHeldNote(r: ReplayInfo, planSource?: string): string | null {
  if (r.status !== 'other_plan') return null
  return planSource === 'optimized'
    ? 'HR replay was recorded on the original plan — undo the optimization to watch it'
    : 'HR replay was recorded on the default plan — plan forecast shown'
}

export interface LiveInfo {
  /** `on`: the views follow the live session; `other_plan`: live HR is running on another plan (not shown). */
  status: 'on' | 'other_plan' | 'off'
  /** "live · Amazfit Helio Strap" (or "replay (hr_bridge) · …" when hr_bridge replays a file). */
  label: string | null
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
  /** The plan's drills as the timelines draw them. */
  drills: ChartDrill[]
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
  live: LiveInfo
  /** What drives the minute: the demo playback clock, or the wall clock of a live HR session. */
  clock: 'replay' | 'live'
  /** "Skip to heat": the earliest minute the engine forecasts anyone crossing the line (else the first gates flag). */
  skipTo: number | null
}

const EMIT_HZ = 12
/** Longest step one animation frame may take (a backgrounded tab doesn't jump the clock). */
const MAX_FRAME_S = 0.1

const NO_REPLAY: ReplayInfo = { status: 'idle', synthetic: false, label: null, file: null, athletes: [], error: null }

class Session {
  // Until the engine answers, the plan structure from fixtures/plan.json (the same file /demo/inputs serves); no numbers.
  private plan: PracticePlan | null = DEFAULT_CONTRACT_PLAN
  private sim: SimulationResult | null = null
  private offlineIds: string[] | null = null
  private replay: LiveReplay | null = null
  private replayInfo: ReplayInfo = NO_REPLAY
  private replayAbort: AbortController | null = null
  private curves: CurveCache | null = null
  private drills: { plan: PracticePlan | null; drills: ChartDrill[] } = { plan: null, drills: [] }
  private minute = 0
  private running = false
  private autoplay = false
  private speed = 1
  private last = 0
  private sinceEmit = 0
  private raf = 0
  private listeners = new Set<() => void>()
  private snapshot!: SessionState
  private session = 0
  /** When /live/state last answered (its `minute` is advanced by wall time between polls). */
  private livePolledAt = 0
  private liveCurves: { key: object | null; total: number; cache: CurveCache | null } = { key: null, total: 0, cache: null }
  private liveTick: ReturnType<typeof setInterval> | null = null

  constructor() {
    liveStore.subscribe(() => {
      this.livePolledAt = Date.now()
      this.syncLiveTick()
      this.publish()
    })
    this.publish()
  }

  /** While a live session is on screen, re-publish every second so the wall clock moves between polls. */
  private syncLiveTick() {
    const on = liveApplies(liveStore.get(), this.plan) === 'on'
    if (on && !this.liveTick) this.liveTick = setInterval(() => this.publish(), 1000)
    if (!on && this.liveTick) {
      clearInterval(this.liveTick)
      this.liveTick = null
    }
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

  /**
   * Today's plan and its /simulate result (null while the engine hasn't answered). `replayFor` says whether the HR
   * file belongs to this plan; only then is it replayed.
   */
  setPlan(plan: PracticePlan, sim: SimulationResult | null, replayFor: ReplayFor) {
    this.plan = plan
    this.sim = sim
    this.offlineIds = null
    this.curves = sim ? makeCurveCache(sim.step_min, planMinutes(plan)) : null
    this.clearReplay()
    if (sim && replayFor === 'other_plan') this.replayInfo = { ...NO_REPLAY, status: 'other_plan' }
    if (sim && replayFor === 'unknown')
      this.replayInfo = { ...NO_REPLAY, status: 'error', error: "the engine's demo plan is unknown (GET /demo/inputs failed)" }
    this.reset()
    this.resume()
    this.syncLiveTick()
    if (sim && replayFor === 'this_plan') void this.loadReplay(plan)
  }

  /** Engine unreachable: the plan structure and roster stay on screen with no numbers ("—", badged). */
  setOffline(plan: PracticePlan, athleteIds: string[]) {
    this.plan = plan
    this.sim = null
    this.offlineIds = athleteIds
    this.curves = null
    this.clearReplay()
    this.reset()
    this.resume()
  }

  private clearReplay() {
    this.replayAbort?.abort()
    this.replayAbort = null
    this.replay = null
    this.replayInfo = NO_REPLAY
  }

  /** POST /live/replay?demo=1 for this plan (deterministic and cached on the engine). */
  private async loadReplay(plan: PracticePlan) {
    const ctl = new AbortController()
    this.replayAbort = ctl
    this.replayInfo = { ...NO_REPLAY, status: 'loading' }
    this.publish()
    try {
      const r = await liveReplay(plan, ctl.signal)
      if (ctl.signal.aborted || this.plan !== plan) return
      this.replay = r
      this.curves = makeCurveCache(r.plan_forecast.step_min, planMinutes(plan))
      this.replayInfo = {
        status: 'ready',
        synthetic: r.source.synthetic,
        label: replaySourceLabel(r),
        file: r.source.file,
        athletes: r.source.athletes,
        error: null,
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError' || this.plan !== plan) return
      this.replay = null
      this.replayInfo = { ...NO_REPLAY, status: 'error', error: (e as Error).message }
    }
    this.publish()
  }

  /** Start playing once a plan is in (the app asks to play before the engine has answered). */
  private resume() {
    if (this.autoplay && !this.running) {
      this.autoplay = false
      this.play()
    }
  }

  play() {
    if (this.running) return
    if (!this.plan) {
      this.autoplay = true
      return
    }
    if (this.minute >= this.total) this.minute = 0
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
    this.publish()
  }

  pause() {
    this.autoplay = false
    this.running = false
    cancelAnimationFrame(this.raf)
    this.publish()
  }

  setSpeed(speed: number) {
    this.speed = speed
    this.publish()
  }

  /** Jump the playback clock (demo control). Every number is re-read from the engine result at that minute. */
  seek(toMinute: number) {
    if (this.snapshot?.clock === 'live') return // a live session follows the wall clock
    this.minute = Math.max(0, Math.min(toMinute, this.total))
    this.last = performance.now()
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

  private drillsOf(plan: PracticePlan | null): ChartDrill[] {
    if (this.drills.plan !== plan) this.drills = { plan, drills: chartDrills(plan) }
    return this.drills.drills
  }

  private publish() {
    const plan = this.plan
    const total = this.total
    const live = liveStore.get()
    const liveStatus = this.sim ? liveApplies(live, plan) : 'off'
    const onLive = liveStatus === 'on' && !!live?.reforecast && live.minute != null
    // Live: the engine's wall-clock minute, advanced by wall time since the poll. Demo: the playback clock.
    const minute = onLive
      ? Math.max(0, Math.min(total, live!.minute! + (Date.now() - this.livePolledAt) / 60_000))
      : this.minute
    const at = plan ? drillAtMinute(plan.drills, minute) : null
    const athletes: Record<string, AthleteLive> = {}
    let weather: WeatherHour | null = null
    let limitC: number | null = null
    let labels: string[] = []
    let source: SessionSource = 'loading'
    let startIso = plan?.start ?? null

    if (plan && onLive) {
      source = 'engine'
      const rf = live!.reforecast!
      if (this.liveCurves.key !== rf || this.liveCurves.total !== total)
        this.liveCurves = { key: rf, total, cache: makeCurveCache(rf.step_min, total) }
      for (const a of rf.athletes) {
        const row = athleteFromLive({ id: a.id, minute, totalMin: total, reforecast: rf, entry: live!.athletes[a.id], curves: this.liveCurves.cache ?? undefined })
        if (row) athletes[a.id] = row
      }
      startIso = live!.plan_start ?? plan.start
      // A live session runs on today's clock; when the saved forecast doesn't cover it the engine uses its nearest
      // hours (and says so in `labels`) — the card shows that same hour.
      weather = weatherHourAt(rf.weather, startIso, minute, true)
      limitC = rf.limit_core_c
      labels = [...new Set([...live!.labels, ...rf.labels])]
    } else if (plan && this.sim) {
      source = 'engine'
      // The replay's plan_forecast is the prior it calibrates from; /simulate until it arrives.
      const forecast = this.replay?.plan_forecast ?? this.sim
      for (const a of forecast.athletes) {
        const live = athleteAtMinute({ id: a.id, minute, totalMin: total, plan: forecast, replay: this.replay, curves: this.curves ?? undefined })
        if (live) athletes[a.id] = live
      }
      weather = weatherHourAt(forecast.weather, plan.start, minute)
      limitC = forecast.limit_core_c
      labels = this.replay ? [...new Set([...this.replay.labels, ...forecast.labels])] : forecast.labels
    } else if (plan && this.offlineIds) {
      source = 'offline'
      for (const id of this.offlineIds) athletes[id] = offlineAthlete(id)
      labels = ['offline fallback']
    }

    this.snapshot = {
      session: this.session,
      minute,
      totalMinutes: total,
      startHour: startIso ? (hourOf(startIso) ?? 0) : 0,
      plan,
      drills: this.drillsOf(plan),
      drillIndex: at?.index ?? 0,
      drillMinuteLeft: at?.minuteLeft ?? 0,
      nextBreakIn: plan ? nextBreakIn(plan.drills, minute) : null,
      running: this.running,
      speed: this.speed,
      source,
      athletes,
      weather,
      limitC,
      labels,
      replay: this.replayInfo,
      live: { status: liveStatus, label: liveLabel(live) },
      clock: onLive ? 'live' : 'replay',
      // The wall clock can't be skipped.
      // "Skip to heat" lands where an estimate reaches the line (the red alert), else the first p95 crossing / flag.
      skipTo: onLive ? null : (firstEstimateCrossing(athletes, limitC) ?? firstCrossing(athletes) ?? firstFlagMinute(this.replay)),
    }
    this.listeners.forEach((fn) => fn())
  }
}

export const engine = new Session()

export function useSession(): SessionState {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot)
}

/** An athlete's numbers at the session minute; a row with no numbers while loading or offline. */
export function athleteOf(s: SessionState, id: string): AthleteLive {
  return s.athletes[id] ?? offlineAthlete(id)
}
