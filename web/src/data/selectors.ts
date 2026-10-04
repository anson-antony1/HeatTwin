import type { ContractDrill, ContractGear, PracticePlan } from './llmPlan'
import type {
  AthleteStatus,
  CalibratedCurve,
  DemoInputs,
  FhsaaZoneRule,
  Gates,
  LiveAthlete,
  LiveReplay,
  NataPhase,
  ReplayFrame,
  SettingsResponse,
  SimulationResult,
  Sources,
  WeatherHour,
} from './engineApi'

// Pure mappings from engine responses to what the views draw. No physiology,
// no thresholds: every number returned here is an engine field picked out for a
// practice minute (or plan-structure arithmetic). Unit-tested in
// __tests__/selectors.test.ts.

// ── time axis ──────────────────────────────────────────────────────────────

/**
 * Index into an engine series for practice minute `m`. The engine reports the state at the END of each step
 * (`times[k]` = start + (k + 1)·step_min), so minute m reads the latest output at or before m — no interpolation.
 * Before the first output (m < step) it reads the first one.
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

/** Highest value of an engine series between two practice minutes (inclusive), or null when none. */
export function maxBetween(series: number[], stepMin: number, from: number, to: number): number | null {
  if (!series.length) return null
  let best: number | null = null
  for (let m = Math.round(from); m <= Math.round(to); m++) {
    const v = valueAtMinute(series, stepMin, m)
    if (v != null && (best == null || v > best)) best = v
  }
  return best
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

export type DrillKind = 'warmup' | 'individual' | 'team' | 'conditioning' | 'break'

/** Display kind of a drill (colour of its block only; no MET, no physiology). */
export function drillKind(d: ContractDrill, index: number): DrillKind {
  if (d.is_break) return 'break'
  if (d.intensity === 'max') return 'conditioning'
  if (d.intensity === 'hard') return 'team'
  if (d.intensity === 'light' || d.intensity === 'rest') return index === 0 ? 'warmup' : 'individual'
  return 'individual'
}

/** A drill as the timeline / chart underlay draws it. */
export interface ChartDrill {
  id: string
  name: string
  kind: DrillKind
  minutes: number
  gear: ContractGear
}

export function chartDrills(plan: Pick<PracticePlan, 'drills'> | null): ChartDrill[] {
  return (plan?.drills ?? []).map((d, i) => ({
    id: d.id,
    name: d.name.charAt(0).toUpperCase() + d.name.slice(1),
    kind: drillKind(d, i),
    minutes: d.duration_min,
    gear: d.gear,
  }))
}

export const GEAR_LABEL: Record<ContractGear, string> = {
  none: 'No pads',
  helmet: 'Helmet',
  helmet_shoulder_pads: 'Shells',
  full_pads: 'Full pads',
}

// ── weather & FHSAA ────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN

/**
 * The engine's weather hour that contains practice minute `m` (WeatherHour is hourly: it covers [time, time + 1 h)).
 * No interpolation. Null when the engine sent no hour for that time.
 */
export function weatherHourAt(
  weather: WeatherHour[] | null | undefined,
  startIso: string,
  m: number,
  /** Outside the forecast, use its first / last hour — as the engine does ("nearest hours used", np.interp clamps). */
  clamp = false,
): WeatherHour | null {
  if (!weather?.length) return null
  const t0 = Date.parse(startIso)
  if (Number.isNaN(t0)) return null
  const t = t0 + m * MS_PER_MIN
  for (const h of weather) {
    const h0 = Date.parse(h.time)
    if (h0 <= t && t < h0 + MS_PER_HOUR) return h
  }
  if (!clamp) return null
  const sorted = [...weather].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return t < Date.parse(sorted[0].time) ? sorted[0] : sorted[sorted.length - 1]
}

/** Highest engine FHSAA zone over the practice window [0, totalMin]. */
export function peakZone(weather: WeatherHour[] | null | undefined, startIso: string, totalMin: number): number | null {
  let z: number | null = null
  for (let m = 0; m <= totalMin; m += 1) {
    const h = weatherHourAt(weather, startIso, m)
    if (h && (z == null || h.fhsaa_zone > z)) z = h.fhsaa_zone
  }
  return z
}

/** FHSAA Policy 41 §41.8.3 rule for a zone number, from GET /sources. */
export function zoneRule(rules: FhsaaZoneRule[] | undefined, zone: number | null | undefined): FhsaaZoneRule | null {
  if (!rules || zone == null) return null
  return rules.find((r) => r.zone === zone) ?? null
}

export const FHSAA_CITATION = 'FHSAA Policy 41 §41.8.3'

/** One short line of rule text for a zone, words and numbers straight from the cited table. */
export function zoneRuleText(r: FhsaaZoneRule): string {
  if (r.max_duration_min === 0) return r.activity
  const parts: string[] = []
  if (r.breaks_per_hour != null && r.breaks_per_hour > 0 && r.break_min != null)
    parts.push(`${r.breaks_per_hour} breaks of ${r.break_min} min per hour`)
  else parts.push(r.activity)
  if (r.max_duration_min != null && r.max_duration_min > 0) parts.push(`max ${r.max_duration_min} min`)
  return parts.join(' · ')
}

/** A few words for a zone (field card): its breaks per hour, or the table's activity text. */
export function zoneShortText(r: FhsaaZoneRule): string {
  if (r.max_duration_min === 0) return r.activity
  if (r.breaks_per_hour != null && r.breaks_per_hour > 0) return `${r.breaks_per_hour} breaks/h`
  return r.activity
}

/** Display name of a WeatherHour source (the field card chip). */
export function weatherSourceLabel(source: string | null | undefined): string {
  if (source === 'nws_forecast') return 'NWS forecast'
  if (source === 'fixture') return 'NWS fixture'
  if (source === 'field_node') return 'Field node'
  if (source === 'assimilated') return 'Node + NWS'
  return '—'
}

// ── simulation summaries ───────────────────────────────────────────────────

export function statusCounts(athletes: { status: AthleteStatus | null }[]): Record<AthleteStatus, number> {
  const c: Record<AthleteStatus, number> = { below_limit: 0, near_limit: 0, over_limit: 0 }
  for (const a of athletes) if (a.status) c[a.status]++
  return c
}

export function hottestPeakP95(sim: Pick<SimulationResult, 'athletes'> | null | undefined): number | null {
  if (!sim?.athletes.length) return null
  return Math.max(...sim.athletes.map((a) => a.peak_core_c_p95))
}

export function overCount(sim: Pick<SimulationResult, 'athletes'> | null | undefined): number | null {
  return sim ? sim.athletes.filter((a) => a.status === 'over_limit').length : null
}

/** The AT-owned planning line: the result's `limit_core_c`, else GET /settings. */
export function planningLimit(settings: SettingsResponse | null, sim: Pick<SimulationResult, 'limit_core_c'> | null): number | null {
  if (sim && Number.isFinite(sim.limit_core_c)) return sim.limit_core_c
  const s = settings?.settings.find((x) => x.key === 'planning_limit_core_c')
  return s && typeof s.value === 'number' ? s.value : null
}

/** The engine roster names fictional athletes "Name (fictional)"; the screens show the name and a "synthetic roster" label. */
export function shortName(name: string): string {
  return name.replace(/\s*\(fictional\)\s*/i, '')
}

// ── the engine's demo plan ─────────────────────────────────────────────────

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

// ── cited constants (GET /sources) ─────────────────────────────────────────

/** Length of the heat-acclimatization period: the longest of nata_ehs.acclimatization_days. */
export function acclimatizationDays(sources: Sources | null | undefined): number | null {
  const d = sources?.nata_ehs?.acclimatization_days
  return Array.isArray(d) && d.length ? Math.max(...d) : null
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

/** Still in a NATA phase that limits gear (the early, highest-risk days); null when the phases are unknown. */
export function inEarlyPhase(phases: NataPhase[] | undefined, day: number): boolean | null {
  if (!phases?.length) return null
  const g = nataMaxGear(phases, day)
  return g != null && g !== 'full_pads'
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
 * Replayed HR at minute m: the latest [minute, bpm] point at or before m. Null before the recording starts and once
 * it has ended (later than one sample spacing after the last point).
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

/** First minute the engine's gates raised a flag for anyone in the replay. */
export function firstFlagMinute(replay: LiveReplay | null): number | null {
  if (!replay) return null
  let first: number | null = null
  for (const f of replay.frames) if (f.gates.flag && (first == null || f.minute < first)) first = f.minute
  return first
}

export function hasHr(replay: LiveReplay | null, athleteId: string): boolean {
  return !!replay && (replay.source.athletes.includes(athleteId) || !!replay.hr_series[athleteId]?.length)
}

/** Provenance label of the replay ("replay · <date> · <device>" / "replay · synthetic HR file (not a real athlete)"). */
export function replaySourceLabel(replay: LiveReplay | null): string | null {
  if (!replay) return null
  if (replay.source.label) return replay.source.label
  return replay.source.synthetic ? 'replay · synthetic HR file (not a real athlete)' : `replay · ${replay.source.file}`
}

// ── one athlete at one minute ──────────────────────────────────────────────

/** Where an athlete's numbers come from right now. */
export type LiveBasis = 'live' | 'hr_replay' | 'plan_forecast' | 'offline'

export interface AthleteLive {
  id: string
  /** Estimated core (p50) at this minute, °C — estimate, planning only. Null offline. */
  coreC: number | null
  /** p95 − p50 at this minute. */
  bandC: number | null
  /** Peak p95 over the session (engine `peak_core_c_p95`). */
  peakP95C: number | null
  /** Practice minute of the p95 peak. */
  peakMin: number | null
  firstCrossMin: number | null
  status: AthleteStatus | null
  hr: number | null
  /** This athlete has HR (replay file or a live strap). */
  hasHr: boolean
  basis: LiveBasis
  /** Engine gates say the HR calibration has enough data (`gates.coverage_ok`). */
  calibrated: boolean
  /** Engine gates raised a flag (`gates.flag`). */
  flag: boolean
  gates: Gates | null
  /** Strap display name when live ("Amazfit Helio Strap"). */
  device: string | null
  /** Live provenance for this athlete: "live · Amazfit Helio Strap", or "replay · <device>" when hr_bridge replays a file. */
  liveSource: string | null
  /** Estimate at each past minute 0…m. */
  history: number[]
  /** Current forecast (p50), one value per minute 0…total. */
  forecast: number[]
  /** p95 − p50 per minute 0…total. */
  band: number[]
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

/** No engine: the same row with no numbers ("—" on screen). */
export function offlineAthlete(id: string): AthleteLive {
  return {
    id,
    coreC: null,
    bandC: null,
    peakP95C: null,
    peakMin: null,
    firstCrossMin: null,
    status: null,
    hr: null,
    hasHr: false,
    basis: 'offline',
    calibrated: false,
    flag: false,
    gates: null,
    device: null,
    liveSource: null,
    history: [],
    forecast: [],
    band: [],
  }
}

/**
 * One athlete at practice minute `m` from the plan forecast and the HR replay:
 *  - HR in the replay and a frame at or before m → that frame's re-forecast, status and gates (engine calibration).
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
  const curves = args.curves ?? makeCurveCache(plan.step_min, totalMin)
  const planC = curves(pa, pa)
  const frame = frameAt(replay, id, minute)
  const withHr = hasHr(replay, id)
  const k = Math.max(0, Math.min(Math.floor(minute), planC.p50.length - 1))

  const cur = frame
    ? { ...curves(frame, frame.athlete), peak: frame.athlete.peak_core_c_p95, status: frame.athlete.status, firstCross: frame.athlete.first_cross_min }
    : { ...planC, peak: pa.peak_core_c_p95, status: pa.status, firstCross: pa.first_cross_min ?? null }

  // What the estimate was at each past minute: the frame in force then, else the plan forecast.
  const history: number[] = []
  for (let t = 0; t <= k; t++) {
    const f = frame ? frameAt(replay, id, t) : null
    history.push(f ? curves(f, f.athlete).p50[t] : planC.p50[t])
  }

  return {
    id,
    coreC: cur.p50[k] ?? null,
    bandC: cur.band[k] ?? null,
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
    device: null,
    liveSource: null,
    history,
    forecast: cur.p50,
    band: cur.band,
  }
}

/**
 * One athlete at wall-clock minute `m` of a live HR session (GET /live/state):
 *  - a strap reading that is still being received and an engine re-forecast → live HR, that curve, status and gates;
 *  - everyone else → the session's `reforecast` (the plan forecast for athletes without HR).
 */
export function athleteFromLive(args: {
  id: string
  minute: number
  totalMin: number
  reforecast: SimulationResult
  entry: LiveAthlete | undefined
  curves?: CurveCache
}): AthleteLive | null {
  const { id, minute, totalMin, reforecast, entry } = args
  const pa = reforecast.athletes.find((a) => a.id === id)
  const live: CalibratedCurve | null = entry?.receiving && entry.athlete ? entry.athlete : null
  if (!pa && !live) return null
  const curves = args.curves ?? makeCurveCache(reforecast.step_min, totalMin)
  const src: CalibratedCurve = live ?? {
    core_c_p50: pa!.core_c_p50,
    core_c_p95: pa!.core_c_p95,
    peak_core_c_p95: pa!.peak_core_c_p95,
    status: pa!.status,
    first_cross_min: pa!.first_cross_min ?? null,
  }
  const c = curves(live ?? pa!, src)
  const k = Math.max(0, Math.min(Math.floor(minute), c.p50.length - 1))
  const receiving = !!entry?.receiving
  return {
    id,
    coreC: c.p50[k] ?? null,
    bandC: c.band[k] ?? null,
    peakP95C: src.peak_core_c_p95,
    peakMin: c.peakMin,
    firstCrossMin: src.first_cross_min,
    status: src.status,
    hr: receiving ? entry!.hr_bpm : null,
    hasHr: receiving,
    basis: live ? 'live' : 'plan_forecast',
    calibrated: !!(live && entry?.gates?.coverage_ok),
    flag: !!(live && entry?.gates?.flag),
    gates: live ? (entry?.gates ?? null) : null,
    device: receiving ? entry!.device : null,
    liveSource: receiving ? `${entry!.replay ? 'replay' : 'live'} · ${entry!.device}` : null,
    history: c.p50.slice(0, k + 1),
    forecast: c.p50,
    band: c.band,
  }
}

/** Plain-words model line for an athlete (Athlete view "Model"). */
export function modelLabel(a: Pick<AthleteLive, 'basis' | 'hasHr' | 'calibrated' | 'liveSource'>): string {
  if (a.basis === 'offline') return 'offline fallback — no estimate'
  if (a.basis === 'live') return `${a.liveSource ?? 'live'} · ${a.calibrated ? 'calibrated from HR' : 'calibrating…'}`
  if (a.basis === 'hr_replay') return a.calibrated ? 'HR replay · calibrated from HR' : 'HR replay · calibrating…'
  return a.hasHr ? 'HR replay · calibrating…' : 'plan forecast only'
}

/**
 * Display tone (CSS class) with voice-plan's meanings: 'alert' (red row, "Over line") only when the engine flags the
 * athlete (`gates.flag`); 'watch' when the engine's p95 forecast is near or over the line (voice-plan's "predicted
 * peak at the line"); 'steady' below it. Colour only — the numbers are the engine's.
 */
export type Tone = 'steady' | 'watch' | 'alert' | 'none'
export function statusTone(s: AthleteStatus | null | undefined, flag = false): Tone {
  if (flag) return 'alert'
  return s === 'over_limit' || s === 'near_limit' ? 'watch' : s === 'below_limit' ? 'steady' : 'none'
}

/** Earliest first crossing among the athletes on screen (for "Skip to heat"). */
export function firstCrossing(athletes: Record<string, Pick<AthleteLive, 'firstCrossMin'>>): number | null {
  let first: number | null = null
  for (const a of Object.values(athletes)) if (a.firstCrossMin != null && (first == null || a.firstCrossMin < first)) first = a.firstCrossMin
  return first
}

/** Body surface area (DuBois) with the engine's own coefficients from GET /sources (constants.body_surface_area);
 * null when /sources isn't loaded. Same formula the engine's physiology uses. */
export function bodySurfaceAreaM2(a: { mass_kg: number; height_m: number }, sources: unknown): number | null {
  const b = (sources as { body_surface_area?: { coeff?: number; mass_exp?: number; height_exp?: number } } | null)
    ?.body_surface_area
  if (!b || b.coeff == null || b.mass_exp == null || b.height_exp == null) return null
  return b.coeff * a.mass_kg ** b.mass_exp * a.height_m ** b.height_exp
}
