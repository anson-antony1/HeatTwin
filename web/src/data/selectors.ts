import type { ContractDrill, ContractGear, PracticePlan } from './llmPlan'
import type {
  AthleteStatus,
  DemoInputs,
  FhsaaZoneRule,
  LiveReplay,
  NataPhase,
  ReplayFrame,
  ReplayGates,
  SettingsResponse,
  SimulationResult,
  WeatherHour,
} from './engineApi'

// Pure mappings from engine responses to what the views draw. No physiology,
// no thresholds: every number returned here is an engine field, picked out for
// a practice minute. Unit-tested in __tests__/selectors.test.ts.

// ── time axis ──────────────────────────────────────────────────────────────

/**
 * Index into an engine series for practice minute `m`. The engine reports the
 * state at the END of each step (`times[k]` = start + (k + 1)·step_min), so
 * minute m reads the latest output at or before m — no interpolation. Before
 * the first output (m < step) it reads the first one.
 */
export function indexAtMinute(stepMin: number, length: number, m: number): number {
  if (length <= 0) return -1
  const k = Math.floor(m / stepMin) - 1
  return Math.max(0, Math.min(length - 1, k))
}

export function valueAtMinute(series: number[], stepMin: number, m: number): number | null {
  const i = indexAtMinute(stepMin, series.length, m)
  return i < 0 ? null : series[i]
}

/** One value per whole practice minute 0…totalMin (length floor(totalMin) + 1), read with `indexAtMinute`. */
export function seriesByMinute(series: number[], stepMin: number, totalMin: number): number[] {
  const n = Math.floor(totalMin)
  const out: number[] = []
  if (!series.length) return out
  for (let m = 0; m <= n; m++) out.push(series[indexAtMinute(stepMin, series.length, m)])
  return out
}

/** Practice minute of the highest value in an engine series (end of that step). */
export function minuteOfPeak(series: number[], stepMin: number): number | null {
  if (!series.length) return null
  let k = 0
  for (let i = 1; i < series.length; i++) if (series[i] > series[k]) k = i
  return (k + 1) * stepMin
}

// ── plan ───────────────────────────────────────────────────────────────────

export function planMinutes(plan: Pick<PracticePlan, 'drills'>): number {
  return plan.drills.reduce((s, d) => s + d.duration_min, 0)
}

/** Local wall-clock hour of an ISO time, as written in the string (e.g. "…T15:30:00-04:00" → 15.5). */
export function hourOf(iso: string): number | null {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  return m ? Number(m[1]) + Number(m[2]) / 60 : null
}

export interface DrillAt {
  drill: ContractDrill
  index: number
  startsAt: number
  minuteLeft: number
}

/** The drill running at practice minute `m` (the last drill once practice is over). */
export function drillAtMinute(drills: ContractDrill[], m: number): DrillAt | null {
  if (!drills.length) return null
  let t = 0
  for (let i = 0; i < drills.length; i++) {
    const d = drills[i]
    if (m < t + d.duration_min) return { drill: d, index: i, startsAt: t, minuteLeft: t + d.duration_min - m }
    t += d.duration_min
  }
  const last = drills.length - 1
  return { drill: drills[last], index: last, startsAt: t - drills[last].duration_min, minuteLeft: 0 }
}

/** Minutes until the next break starts (0 while on a break); null when no break is left. */
export function nextBreakIn(drills: ContractDrill[], m: number): number | null {
  let t = 0
  for (const d of drills) {
    if (d.is_break && t + d.duration_min > m) return Math.max(0, t - m)
    t += d.duration_min
  }
  return null
}

/** End of the last break before `m` (or practice start) and start of the next one — for the "to water" ring. */
export function breakWindow(drills: ContractDrill[], m: number): { from: number; to: number } | null {
  let t = 0
  let from = 0
  for (const d of drills) {
    if (d.is_break) {
      if (t + d.duration_min > m) return { from, to: t }
      from = t + d.duration_min
    }
    t += d.duration_min
  }
  return null
}

// ── weather & FHSAA ────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN

/**
 * The engine's weather hour that contains practice minute `m` (WeatherHour is
 * hourly: it covers [time, time + 1 h)). No interpolation. Null when the
 * engine sent no hour for that time.
 */
export function weatherHourAt(weather: WeatherHour[], startIso: string, m: number): WeatherHour | null {
  const t0 = Date.parse(startIso)
  if (Number.isNaN(t0)) return null
  const t = t0 + m * MS_PER_MIN
  for (const h of weather) {
    const h0 = Date.parse(h.time)
    if (h0 <= t && t < h0 + MS_PER_HOUR) return h
  }
  return null
}

/** FHSAA Policy 41 §41.8.3 rule text for a zone number, from GET /sources. */
export function zoneRule(rules: FhsaaZoneRule[] | undefined, zone: number | null | undefined): FhsaaZoneRule | null {
  if (!rules || zone == null) return null
  return rules.find((r) => r.zone === zone) ?? null
}

export const FHSAA_CITATION = 'FHSAA Policy 41 §41.8.3'

/** One line of rule text for a zone, words and numbers straight from the cited table. */
export function zoneRuleText(r: FhsaaZoneRule): string {
  const parts = [r.activity]
  if (r.breaks_per_hour != null && r.breaks_per_hour > 0 && r.break_min != null)
    parts.push(`${r.breaks_per_hour} breaks of ${r.break_min} min per hour`)
  if (r.max_duration_min != null && r.max_duration_min > 0) parts.push(`max ${r.max_duration_min} min`)
  if (r.gear && r.gear !== 'any' && r.gear !== 'n/a') parts.push(r.gear)
  return parts.join(' · ')
}

// ── simulation summaries ───────────────────────────────────────────────────

export function statusCounts(athletes: { status: AthleteStatus }[]): Record<AthleteStatus, number> {
  const c: Record<AthleteStatus, number> = { below_limit: 0, near_limit: 0, over_limit: 0 }
  for (const a of athletes) c[a.status]++
  return c
}

export function hottestPeakP95(sim: Pick<SimulationResult, 'athletes'>): number | null {
  if (!sim.athletes.length) return null
  return Math.max(...sim.athletes.map((a) => a.peak_core_c_p95))
}

/** The AT-owned near-limit band: GET /settings, else the settings the run used. */
export function nearMargin(settings: SettingsResponse | null, sim: Pick<SimulationResult, 'settings'> | null): number | null {
  const s = settings?.settings.find((x) => x.key === 'near_limit_margin_c')
  if (s && typeof s.value === 'number') return s.value
  const used = sim?.settings?.near_limit_margin_c
  return typeof used === 'number' ? used : null
}

/** The engine roster names fictional athletes "Name (fictional)"; make sure the label is there when synthetic. */
export function displayName(name: string, synthetic: boolean): string {
  if (!synthetic || /\(fictional\)/i.test(name)) return name
  return `${name} (fictional)`
}

// ── the engine's demo plan ─────────────────────────────────────────────────

export const SYNTHETIC_PLAN_LABEL = 'synthetic plan (fixture)'

/** JSON with sorted object keys, so the same drills compare equal whatever key order they arrived in. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(x) ?? 'null'
}

/** The plan on screen is the engine's demo plan (GET /demo/inputs): same id and the same drills. */
export function isDemoPlan(
  plan: Pick<PracticePlan, 'id' | 'drills'> | null | undefined,
  inputs: Pick<DemoInputs, 'plan'> | null | undefined,
): boolean {
  if (!plan || !inputs?.plan) return false
  return plan.id === inputs.plan.id && canonical(plan.drills) === canonical(inputs.plan.drills)
}

/**
 * A view's labels, plus "synthetic plan (fixture)" (first, so it is never folded away) when the plan on screen is
 * the demo plan /demo/inputs marks synthetic and the engine's labels don't already say so.
 */
export function withPlanLabel(
  labels: string[],
  plan: Pick<PracticePlan, 'id' | 'drills'> | null | undefined,
  inputs: Pick<DemoInputs, 'plan' | 'synthetic'> | null | undefined,
): string[] {
  if (!inputs?.synthetic?.plan || !isDemoPlan(plan, inputs) || labels.includes(SYNTHETIC_PLAN_LABEL)) return labels
  return [SYNTHETIC_PLAN_LABEL, ...labels]
}

/** NATA 2009 gear phasing for an acclimatization day (phases from GET /sources), tightened by an AT-set cap. */
export function nataMaxGear(
  phases: NataPhase[] | undefined,
  day: number,
  gearLimit?: ContractGear,
  order: ContractGear[] = ['none', 'helmet', 'helmet_shoulder_pads', 'full_pads'],
): ContractGear | null {
  const phase = phases?.find((p) => day >= p.first_day && day <= p.last_day)
  if (!phase) return gearLimit ?? null
  if (!gearLimit) return phase.max_gear
  return order.indexOf(gearLimit) < order.indexOf(phase.max_gear) ? gearLimit : phase.max_gear
}

// ── HR replay ──────────────────────────────────────────────────────────────

/** Latest calibration frame for an athlete with frame.minute ≤ m (null before the first frame). */
export function frameAt(replay: LiveReplay | null, athleteId: string, m: number): ReplayFrame | null {
  if (!replay) return null
  let best: ReplayFrame | null = null
  for (const f of replay.frames) {
    if (f.athlete_id !== athleteId || f.minute > m) continue
    if (!best || f.minute >= best.minute) best = f
  }
  return best
}

/**
 * Replayed HR at minute m: the latest [minute, bpm] point at or before m.
 * Null before the recording starts and once it has ended (later than one
 * sample spacing after the last point) — a finished file is not a live HR.
 */
export function hrAt(replay: LiveReplay | null, athleteId: string, m: number): number | null {
  const s = replay?.hr_series[athleteId]
  if (!s?.length) return null
  const n = s.length
  const spacing = n > 1 ? s[n - 1][0] - s[n - 2][0] : 0
  if (m > s[n - 1][0] + spacing) return null
  let bpm: number | null = null
  for (const [t, v] of s) {
    if (t > m) break
    bpm = v
  }
  return bpm
}

/** First minute the engine's gates raised a flag for anyone (for "skip ahead"). */
export function firstFlagMinute(replay: LiveReplay | null): number | null {
  if (!replay) return null
  let first: number | null = null
  for (const f of replay.frames) if (f.gates.flag && (first == null || f.minute < first)) first = f.minute
  return first
}

export function hasHr(replay: LiveReplay | null, athleteId: string): boolean {
  return !!replay && (replay.source.athletes.includes(athleteId) || !!replay.hr_series[athleteId]?.length)
}

// ── one athlete at one minute ──────────────────────────────────────────────

/** Where an athlete's numbers come from right now. */
export type LiveBasis = 'hr_replay' | 'plan_forecast' | 'offline'

export interface AthleteLive {
  id: string
  /** Estimated core (p50) at this minute, °C. Estimate — planning only. */
  coreC: number
  /** p95 at this minute, °C. */
  p95C: number
  /** p95 − p50 at this minute. */
  bandC: number
  /** Peak p95 over the session (engine `peak_core_c_p95`). */
  peakP95C: number
  peakMin: number | null
  firstCrossMin: number | null
  status: AthleteStatus
  hr: number | null
  hasHr: boolean
  basis: LiveBasis
  /** Engine gates say the HR calibration has enough data (`gates.coverage_ok`). */
  calibrated: boolean
  /** Engine gates raised a flag (`gates.flag`), with its message. */
  flag: boolean
  gates: ReplayGates | null
  /** Estimate at each past minute 0…m. */
  history: number[]
  /** Current forecast, one value per minute 0…total. */
  forecast: number[]
  /** p95 − p50 per minute 0…total. */
  band: number[]
}

interface Curve {
  p50: number[]
  p95: number[]
  peak: number
  status: AthleteStatus
  firstCross: number | null
}

/** Per-minute arrays for one engine curve (cached by the caller — they don't change with the clock). */
export function curveByMinute(c: { core_c_p50: number[]; core_c_p95: number[] }, stepMin: number, totalMin: number) {
  const p50 = seriesByMinute(c.core_c_p50, stepMin, totalMin)
  const p95 = seriesByMinute(c.core_c_p95, stepMin, totalMin)
  return { p50, p95, band: p95.map((v, i) => v - p50[i]), peakMin: minuteOfPeak(c.core_c_p95, stepMin) }
}

export type CurveCache = (key: object, c: { core_c_p50: number[]; core_c_p95: number[] }) => ReturnType<typeof curveByMinute>

/** A WeakMap-backed cache for `curveByMinute`, keyed by the engine object the curve came from. */
export function makeCurveCache(stepMin: number, totalMin: number): CurveCache {
  const cache = new WeakMap<object, ReturnType<typeof curveByMinute>>()
  return (key, c) => {
    let v = cache.get(key)
    if (!v) {
      v = curveByMinute(c, stepMin, totalMin)
      cache.set(key, v)
    }
    return v
  }
}

/**
 * One athlete at practice minute `m`.
 *  - HR in the replay and a frame at or before m → that frame's re-forecast,
 *    status and gates (engine calibration).
 *  - Otherwise → the plan forecast (no HR).
 */
export function athleteAtMinute(args: {
  id: string
  minute: number
  totalMin: number
  plan: SimulationResult
  replay: LiveReplay | null
  curves?: CurveCache
}): AthleteLive | null {
  const { id, minute, totalMin, plan, replay } = args
  const pa = plan.athletes.find((a) => a.id === id)
  if (!pa) return null
  const step = plan.step_min
  const curves = args.curves ?? makeCurveCache(step, totalMin)
  const planC = curves(pa, pa)
  const frame = frameAt(replay, id, minute)
  const withHr = hasHr(replay, id)
  const k = Math.min(Math.floor(minute), planC.p50.length - 1)

  const cur: Curve & { band: number[]; peakMin: number | null } = frame
    ? (() => {
        const fc = curves(frame, frame.athlete)
        return {
          ...fc,
          peak: frame.athlete.peak_core_c_p95,
          status: frame.athlete.status,
          firstCross: frame.athlete.first_cross_min,
        }
      })()
    : { ...planC, peak: pa.peak_core_c_p95, status: pa.status, firstCross: pa.first_cross_min ?? null }

  // What the estimate was at each past minute: the frame in force then, else the plan forecast.
  const history: number[] = []
  for (let t = 0; t <= k; t++) {
    const f = frame ? frameAt(replay, id, t) : null
    history.push(f ? curves(f, f.athlete).p50[t] : planC.p50[t])
  }

  return {
    id,
    coreC: cur.p50[k],
    p95C: cur.p95[k],
    bandC: cur.band[k],
    peakP95C: cur.peak,
    peakMin: cur.peakMin,
    firstCrossMin: cur.firstCross,
    status: cur.status,
    hr: withHr ? hrAt(replay, id, minute) : null,
    hasHr: withHr,
    basis: frame ? 'hr_replay' : 'plan_forecast',
    calibrated: !!frame?.gates.coverage_ok,
    flag: !!frame?.gates.flag,
    gates: frame?.gates ?? null,
    history,
    forecast: cur.p50,
    band: cur.band,
  }
}

/** Plain-words model line for an athlete (Coach and Athlete views). */
export function basisLabel(a: Pick<AthleteLive, 'basis' | 'hasHr' | 'calibrated' | 'gates'>): string {
  if (a.basis === 'offline') return 'OFFLINE FALLBACK — not the validated model'
  if (a.basis === 'hr_replay')
    return a.calibrated ? 'HR-calibrated estimate (replay)' : `HR replay · engine gates: ${a.gates?.message ?? 'waiting'}`
  return a.hasHr ? 'plan forecast — waiting for the first HR calibration' : 'plan forecast only — no HR'
}

/** HR column text when there is no HR value at this minute. */
export function noHrLabel(a: Pick<AthleteLive, 'basis' | 'hasHr' | 'calibrated' | 'gates' | 'hr'>): string {
  if (a.hasHr && a.hr == null && a.basis === 'hr_replay') return `HR replay ended · ${basisLabel(a)}`
  return basisLabel(a)
}

export const STATUS_LABEL: Record<AthleteStatus, string> = {
  below_limit: 'Below line',
  near_limit: 'Near line',
  over_limit: 'Over line',
}

/** Display tone (CSS class) for an engine status. Colour only. */
export function statusTone(s: AthleteStatus): 'steady' | 'watch' | 'alert' {
  return s === 'over_limit' ? 'alert' : s === 'near_limit' ? 'watch' : 'steady'
}
