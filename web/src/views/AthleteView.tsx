import { useEffect, useRef, useState } from 'react'
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { replayLabel, useSession } from '../data/engine'
import { useEngineMeta } from '../data/engineMeta'
import { useRoster } from '../data/roster'
import { ESTIMATE_LABEL, SAFETY_LINE } from '../data/constants'
import {
  basisLabel,
  breakWindow,
  noHrLabel,
  drillAtMinute,
  nataMaxGear,
  planMinutes,
  seriesByMinute,
  withPlanLabel,
  type AthleteLive,
} from '../data/selectors'
import { BodyFigure } from '../components/BodyFigure'
import { NumberTicker } from '../components/NumberTicker'
import { StatusPill } from '../components/StatusPill'
import { TempChart } from '../components/TempChart'
import { OfflineBadge, OfflineBanner } from '../components/OfflineBadge'
import { ProvenanceLabels } from '../components/ProvenanceLabels'
import { IconDrop, IconHeart, IconResponse } from '../components/Icons'
import { chartDomain, clockLabel, cToF, heatColor } from '../lib/heat'
import { useHeatScale, useNearMargin } from '../lib/useHeatScale'
import { ease, spring } from '../lib/motion'
import { CORE_DECIMALS, coreValue, fmtCore } from '../lib/format'
import { gearFor, usePlanState } from '../data/planStore'
import { AI_NAME } from '../lib/brand'
import './AthleteView.css'

// Athlete twin. Every number is the engine's estimate for this athlete at the
// demo playback minute: the HR-replay calibration frame when there is one,
// else the plan forecast (selectors.ts). Estimate — planning only.

const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Helmet + shoulder pads', full_pads: 'Full pads' }

interface Props {
  athleteId: string
  onSelect: (id: string) => void
  onCollapse: (id: string) => void
}

export function AthleteView({ athleteId, onSelect, onCollapse }: Props) {
  const reduce = useReducedMotion()
  const s = useSession()
  const meta = useEngineMeta()
  return (
    <div className="twin">
      {s.source === 'offline' && <OfflineBanner />}
      <header className="twin__head">
        <div>
          <div className="eyebrow">Athlete twin</div>
          <h1 className="display-lg">Heat forecast</h1>
        </div>
        <Picker athleteId={athleteId} onSelect={onSelect} />
      </header>
      <div className="twin__provenance">
        <span className="twin__tag">demo playback — not live</span>
        {replayLabel(s.replay) && <span className="twin__tag twin__tag--replay">{replayLabel(s.replay)}</span>}
        <ProvenanceLabels labels={withPlanLabel(s.labels, s.plan, meta.inputs)} title={s.source === 'offline' ? 'Offline' : s.replay.status === 'ready' ? 'Engine /live/replay' : 'Engine /simulate'} />
      </div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={athleteId}
          initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
          transition={{ duration: 0.28, ease: ease.out }}
        >
          {s.athletes[athleteId] ? (
            <TwinBody athleteId={athleteId} onCollapse={onCollapse} />
          ) : (
            <p className="faint">Loading the engine’s forecast…</p>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Picker({ athleteId, onSelect }: { athleteId: string; onSelect: (id: string) => void }) {
  const s = useSession()
  const roster = useRoster()
  return (
    <div className="picker glass" role="tablist" aria-label="Choose athlete">
      {roster.athletes.map((a) => {
        const on = a.id === athleteId
        const live = s.athletes[a.id]
        const tone = live?.flag ? 'alert' : live && live.status !== 'below_limit' ? 'watch' : 'steady'
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={on}
            className={`picker__chip num ${on ? 'is-on' : ''} picker__chip--${tone}`}
            onClick={() => onSelect(a.id)}
            title={roster.name(a.id)}
          >
            {on && <motion.span layoutId="picker-thumb" className="picker__thumb" transition={spring.ui} />}
            <span className="picker__label">{a.id.replace(/^\D+/, '') || a.id}</span>
            {tone !== 'steady' && <span className="picker__flag" aria-label={live?.status} />}
          </button>
        )
      })}
    </div>
  )
}

function TwinBody({ athleteId, onCollapse }: { athleteId: string; onCollapse: (id: string) => void }) {
  const s = useSession()
  const roster = useRoster()
  const meta = useEngineMeta()
  const a = roster.byId(athleteId)
  const live = s.athletes[athleteId]
  const drills = s.plan?.drills ?? []
  const drill = drillAtMinute(drills, s.minute)?.drill
  const offline = live.basis === 'offline'
  const scale = useHeatScale()
  const margin = useNearMargin()
  const near = s.limitC != null && margin != null ? s.limitC - margin : null

  // Scrubbing the chart drives the whole page: figure, number, and labels read
  // the scrubbed minute until the coach lets go (mouse) or taps "Live".
  const [scrub, setScrub] = useState<number | null>(null)
  const scrubbed = scrub != null ? readAt(live, s.minute, scrub) : null
  const coreShown = scrubbed ? scrubbed.c : live.coreC
  const zoom = useZoom(s.totalMinutes, scrub ?? s.minute)

  const acclimDays = meta.sources?.nata_ehs?.acclimatization_days
  const ticks = acclimDays?.length ? Math.max(...acclimDays) : 0
  const gearMax = a ? nataMaxGear(meta.sources?.nata_gear_phasing?.phases, a.acclimatization_day, a.gear_limit) : null

  return (
    <div className="twin__grid">
      {/* Vitals — the Figma's tall left card */}
      <section className="glass card vitals">
        <div className="vitals__who">
          <span className="vitals__num num">{a?.position ?? '—'}</span>
          <div>
            <div className="display-sm">{roster.name(athleteId)}</div>
            {a && (
              <div className="faint" style={{ fontSize: 13 }}>
                {a.mass_kg} kg · {a.height_m} m · age {a.age_yr}
              </div>
            )}
          </div>
        </div>

        <div className="vitals__core">
          <div className="vitals__eyebrow">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={scrubbed ? 'scrub' : 'live'}
                className="eyebrow"
                initial={{ opacity: 0, filter: 'blur(3px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(3px)' }}
                transition={{ duration: 0.18, ease: ease.out }}
              >
                {scrubbed
                  ? `${scrubbed.measured ? 'Estimate' : 'Forecast'} · ${clockLabel(s.startHour, scrub!)}`
                  : 'Estimated core (p50)'}
              </motion.span>
            </AnimatePresence>
            {scrubbed && (
              <button className="vitals__live pressable" onClick={() => setScrub(null)}>
                Now
              </button>
            )}
          </div>
          <div className="display-xl vitals__temp" style={{ color: heatColor(coreShown, scale) }}>
            <NumberTicker value={coreValue(coreShown, s.limitC)} decimals={CORE_DECIMALS} suffix="°C" />
          </div>
          <div className="muted num" style={{ fontSize: 14 }}>
            {cToF(coreShown).toFixed(1)} °F · ±{(scrubbed ? scrubbed.band : live.bandC).toFixed(2)}° (p95 − p50)
            {offline && <OfflineBadge compact />}
          </div>
          <div className="faint" style={{ fontSize: 12.5 }}>
            {ESTIMATE_LABEL}
          </div>
        </div>

        <StatusPill status={live.status} />

        <dl className="vitals__list">
          <div>
            <dt>Heart rate</dt>
            <dd>
              {live.hr != null ? (
                <span className="vitals__hr">
                  <IconHeart width={16} height={16} />
                  <NumberTicker value={live.hr} suffix="bpm" />
                </span>
              ) : (
                <span className="faint">{noHrLabel(live)}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Forecast peak (p95)</dt>
            <dd className="num">
              {fmtCore(live.peakP95C, s.limitC)}°{live.peakMin != null ? ` at ${clockLabel(s.startHour, live.peakMin)}` : ''}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{basisLabel(live)}</dd>
          </div>
        </dl>

        {live.flag && (
          <button className="btn btn--alert pressable vitals__cta" onClick={() => onCollapse(athleteId)}>
            <IconResponse width={18} height={18} /> Collapse response
          </button>
        )}
      </section>

      {/* The twin itself */}
      <section className="twin__figure" aria-label="Thermal figure">
        <BodyFigure coreC={coreShown} hr={scrubbed ? null : live.hr} scale={scale} />
        <div className="twin__callout twin__callout--core">
          <span className="twin__callout-dot" style={{ background: heatColor(coreShown, scale) }} />
          Core (estimate)
        </div>
        {live.hr != null && !scrubbed && (
          <div className="twin__callout twin__callout--hr">
            <span className="twin__callout-dot" />
            HR replay
          </div>
        )}
      </section>

      {/* Today — top-right card */}
      <section className="glass card today">
        <div className="today__now">
          <div className="eyebrow">Demo clock · {clockLabel(s.startHour, s.minute)}</div>
          <div className="display-sm">{drill ? drill.name.charAt(0).toUpperCase() + drill.name.slice(1) : '—'}</div>
          {drill && (
            <div className="muted" style={{ fontSize: 13.5 }}>
              {GEAR[gearFor(drill, athleteId)]} · <span className="num">{Math.ceil(s.drillMinuteLeft)}</span> min left
            </div>
          )}
        </div>
        <BreakRing minutes={s.nextBreakIn} window={breakWindow(drills, s.minute)} now={s.minute} />
      </section>

      {/* Forecast — tall right card */}
      <section className="glass card forecast">
        <div className="forecast__head">
          <div>
            <div className="eyebrow">Core temperature · this session · {ESTIMATE_LABEL}</div>
            <div className="display-sm">
              {live.status === 'over_limit'
                ? 'Forecast p95 crosses the planning line'
                : live.status === 'near_limit'
                  ? 'Forecast p95 near the planning line'
                  : 'Forecast p95 below the planning line'}
            </div>
          </div>
          <div className="forecast__tools">
            <ul className="legend">
              <li><span className="legend__swatch legend__swatch--est" />Estimate</li>
              <li><span className="legend__swatch legend__swatch--fc" />Forecast</li>
              <li><span className="legend__swatch legend__swatch--band" />p95</li>
            </ul>
            <div className="zoom" role="radiogroup" aria-label="Zoom">
              {ZOOMS.map((z) => (
                <button
                  key={z}
                  role="radio"
                  aria-checked={zoom.level === z}
                  className={`zoom__btn num ${zoom.level === z ? 'is-on' : ''}`}
                  onClick={() => zoom.setLevel(z)}
                >
                  {zoom.level === z && <motion.span layoutId="zoom-thumb" className="zoom__thumb" transition={spring.ui} />}
                  <span>{z}×</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="forecast__chart" onWheel={zoom.onWheel}>
          <TempChart
            reveal
            history={live.history}
            forecast={live.forecast}
            band={live.band}
            total={s.totalMinutes}
            now={s.minute}
            live={live.coreC}
            drills={drills}
            limit={s.limitC}
            near={near}
            scale={scale}
            view={zoom.view}
            startHour={s.startHour}
            scrub={scrub}
            onScrub={setScrub}
          />
        </div>
        <AnimatePresence initial={false}>
          {zoom.level > 1 && (
            <motion.div
              key="nav"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: ease.out }}
              style={{ overflow: 'hidden' }}
            >
              <Navigator series={live.forecast} total={s.totalMinutes} view={zoom.view} onPan={zoom.panTo} limit={s.limitC} />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="forecast__hint faint">
          {zoom.level > 1 ? 'Drag across the chart to scrub · drag the window below to move' : 'Drag across the chart to scrub through practice'}
        </div>
      </section>

      {/* Acclimatization — bottom-left card */}
      <section className="glass card acclim">
        <div className="acclim__head">
          <div>
            <div className="eyebrow">Heat acclimatization</div>
            <div className="display-sm">
              Day <span className="num">{a?.acclimatization_day ?? '—'}</span>
              {ticks > 0 && <> of {ticks}</>}
            </div>
          </div>
        </div>
        {ticks > 0 && a && (
          <div className="acclim__bar" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${ticks}, 1fr)` }}>
            {Array.from({ length: ticks }, (_, i) => (
              <span key={i} className={i < a.acclimatization_day ? 'is-on' : ''} style={{ transitionDelay: `${i * 30}ms` }} />
            ))}
          </div>
        )}
        {gearMax && (
          <p className="acclim__note muted">
            Gear allowed today: <strong>{GEAR[gearMax]}</strong>
            {a?.gear_limit ? ' (AT-set limit)' : ''} — NATA 2009 preseason phasing by acclimatization day.
          </p>
        )}
        {acclimDays?.length ? (
          <p className="acclim__note faint">NATA: heat acclimatization takes {acclimDays.join('–')} days.</p>
        ) : null}
      </section>

      <AthletePlanCard athleteId={athleteId} minute={s.minute} />

      <p className="twin__safety faint">{SAFETY_LINE}</p>
    </div>
  )
}

function BreakRing({
  minutes,
  window: win,
  now,
}: {
  minutes: number | null
  window: { from: number; to: number } | null
  now: number
}) {
  const r = 30
  const c = 2 * Math.PI * r
  const onBreak = minutes === 0
  const frac = onBreak ? 1 : win && win.to > win.from ? Math.max(0, Math.min(1, (now - win.from) / (win.to - win.from))) : 0
  return (
    <div className="ring">
      <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
        <circle cx="38" cy="38" r={r} className="ring__track" />
        <circle
          cx="38"
          cy="38"
          r={r}
          className="ring__fill"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 38 38)"
        />
      </svg>
      <div className="ring__label">
        {onBreak ? (
          <IconDrop width={20} height={20} />
        ) : minutes == null ? (
          '—'
        ) : (
          <span className="num">{Math.ceil(minutes)}′</span>
        )}
      </div>
      <div className="ring__cap faint">{onBreak ? 'Water break' : 'to water'}</div>
    </div>
  )
}

// ---------- Scrub + zoom helpers ----------

const ZOOMS = [1, 2, 4] as const
type ZoomLevel = (typeof ZOOMS)[number]

/** Value the page shows for a minute: the estimate so far, or the forecast (with its band) beyond now. */
function readAt(live: Pick<AthleteLive, 'history' | 'forecast' | 'band' | 'coreC'>, now: number, m: number) {
  const k = Math.floor(now)
  if (m <= k) return { c: live.history[m] ?? live.coreC, band: 0, measured: true }
  if (m <= now) return { c: live.coreC, band: 0, measured: true }
  return { c: live.forecast[m] ?? live.forecast[live.forecast.length - 1], band: live.band[m] ?? 0, measured: false }
}

/** Zoom level + visible window. Zoom changes glide (on-screen movement → ease-in-out); panning tracks 1:1. */
function useZoom(total: number, focus: number) {
  const reduce = useReducedMotion()
  const [level, setLevelState] = useState<ZoomLevel>(1)
  const [view, setView] = useState<[number, number]>([0, total])
  const viewRef = useRef(view)
  useEffect(() => {
    viewRef.current = view
  }, [view])

  const clampWindow = (center: number, span: number): [number, number] => {
    const half = span / 2
    const c = Math.max(half, Math.min(total - half, center))
    return [c - half, c + half]
  }

  // Keep the window valid when the plan's length changes.
  useEffect(() => {
    const span = total / level
    const c = (viewRef.current[0] + viewRef.current[1]) / 2
    setView(clampWindow(c, span)) // eslint-disable-line react-hooks/set-state-in-effect
  }, [total]) // eslint-disable-line react-hooks/exhaustive-deps

  const setLevel = (z: ZoomLevel) => {
    setLevelState(z)
    const target = clampWindow(z === 1 ? total / 2 : focus, total / z)
    if (reduce) return setView(target)
    const from = viewRef.current
    animate(0, 1, {
      duration: 0.32,
      ease: ease.inOut,
      onUpdate: (t) => setView([from[0] + (target[0] - from[0]) * t, from[1] + (target[1] - from[1]) * t]),
    })
  }

  const panTo = (center: number) => setView(clampWindow(center, viewRef.current[1] - viewRef.current[0]))

  const onWheel = (e: React.WheelEvent) => {
    if (level === 1) return
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0
    if (!dx) return
    const span = viewRef.current[1] - viewRef.current[0]
    panTo((viewRef.current[0] + viewRef.current[1]) / 2 + (dx / 600) * span)
  }

  return { level, view, setLevel, panTo, onWheel }
}

/** Overview strip: the whole session, with a window you drag to move the zoomed chart. */
function Navigator({
  series,
  total,
  view,
  onPan,
  limit,
}: {
  series: number[]
  total: number
  view: [number, number]
  onPan: (center: number) => void
  limit: number | null
}) {
  const ref = useRef<HTMLDivElement>(null)
  const grab = useRef<number | null>(null)
  const [lo, hi] = chartDomain(series, [limit])
  const pts = series.map((v, i) => `${((i / total) * 100).toFixed(2)},${(32 - ((v - lo) / (hi - lo)) * 28).toFixed(2)}`)
  const minuteAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * total
  }
  const center = (view[0] + view[1]) / 2

  return (
    <div
      ref={ref}
      className="nav"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        const m = minuteAt(e.clientX)
        const inside = m >= view[0] && m <= view[1]
        // Respect where the window was grabbed; a click outside jumps it there.
        grab.current = inside ? m - center : 0
        if (!inside) onPan(m)
      }}
      onPointerMove={(e) => {
        if (grab.current == null) return
        onPan(minuteAt(e.clientX) - grab.current)
      }}
      onPointerUp={() => (grab.current = null)}
      onPointerCancel={() => (grab.current = null)}
    >
      <svg viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={pts.join(' ')} className="nav__line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div
        className="nav__window"
        style={{ left: `${(view[0] / total) * 100}%`, width: `${((view[1] - view[0]) / total) * 100}%` }}
      />
    </div>
  )
}

/** Today's plan as this athlete will live it: their gear, their engine p95 per block. */
function AthletePlanCard({ athleteId, minute }: { athleteId: string; minute: number }) {
  const p = usePlanState()
  const reduce = useReducedMotion()
  const scale = useHeatScale()
  const drills = p.plan.drills
  const total = planMinutes(p.plan)
  const simA = p.sim?.athletes.find((x) => x.id === athleteId)
  const offA = !p.sim ? p.offline?.athletes.find((x) => x.id === athleteId) : undefined
  const p95 = simA && p.sim ? seriesByMinute(simA.core_c_p95, p.sim.step_min, total) : (offA?.curve ?? null)
  const limit = p.sim?.limit_core_c ?? p.offline?.limitC ?? null

  const source =
    p.source === 'voice'
      ? `Described by voice${p.confirmedAt ? ` · ${new Date(p.confirmedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
      : p.source === 'optimized'
        ? 'Optimized by the engine'
        : p.source === 'edited'
          ? 'Edited by the coach'
          : 'Engine demo plan'

  const starts = drills.map((_, i) => drills.slice(0, i).reduce((sum, d) => sum + d.duration_min, 0))
  const blocks = drills.map((d, i) => {
    const start = starts[i]
    const end = start + d.duration_min
    const seg = p95 ? p95.slice(Math.round(start), Math.round(end) + 1) : []
    const peak = seg.length ? Math.max(...seg) : null
    const sitsOut = d.participants != null && !d.participants.includes(athleteId)
    return { d, peak, sitsOut, gear: gearFor(d, athleteId) }
  })

  return (
    <section className="glass card dayplan" aria-label="Today's plan">
      <div className="dayplan__head">
        <div>
          <div className="eyebrow">Today’s plan</div>
          <div className="display-sm">
            {simA && limit != null
              ? simA.first_cross_min != null
                ? `Forecast p95 crosses ${limit.toFixed(1)}° at minute ${Math.round(simA.first_cross_min)}`
                : `Forecast p95 peak ${fmtCore(simA.peak_core_c_p95, limit)}° (line ${limit.toFixed(1)}°)`
              : `${drills.length} blocks · ${Math.round(total)} min`}
          </div>
        </div>
        <span className={`dayplan__source dayplan__source--${p.source}`}>{source}</span>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={`${p.plan.id}-${p.source}-${p.confirmedAt ?? 0}`}
          className="dayplan__track"
          initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
          transition={{ duration: 0.3, ease: ease.out }}
        >
          {blocks.map(({ d, peak, sitsOut, gear }, i) => (
            <motion.div
              key={d.id}
              className={`dayblock ${d.is_break ? 'is-break' : ''} ${sitsOut ? 'is-out' : ''}`}
              style={{ flexGrow: d.duration_min, flexBasis: 0, ['--heat' as string]: peak != null && !d.is_break ? heatColor(peak, scale) : undefined }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ duration: 0.28, ease: ease.out, delay: i * 0.035 }}
              title={`${d.name} · ${d.duration_min} min · ${GEAR[gear]}${peak != null ? ` · peak p95 ${fmtCore(peak, limit)}°` : ''}`}
            >
              {d.duration_min / total > 0.07 && (
                <span className="dayblock__text">
                  <span className="dayblock__name">{d.is_break ? 'Water' : d.name.charAt(0).toUpperCase() + d.name.slice(1)}</span>
                  <span className="dayblock__meta num">
                    {d.duration_min}′{!d.is_break && ` · ${sitsOut ? 'sits out' : GEAR[gear]}`}
                  </span>
                </span>
              )}
              {peak != null && limit != null && !d.is_break && d.duration_min / total > 0.07 && (
                <span className={`dayblock__peak num ${peak >= limit ? 'is-over' : ''}`}>{fmtCore(peak, limit)}°</span>
              )}
            </motion.div>
          ))}
          {minute > 0 && minute < total && (
            <span className="dayplan__now" style={{ left: `${(minute / total) * 100}%` }} aria-hidden="true" />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="dayplan__foot faint">
        {simA
          ? `Peak per block is the engine’s p95 estimate for this athlete — ${ESTIMATE_LABEL}. The line is an illustrative default an athletic trainer owns.`
          : offA
            ? 'OFFLINE FALLBACK — stand-in curve, not the validated model.'
            : `Tap the mic and describe today’s practice to ${AI_NAME} to model it on the engine.`}
        {p.draft?.transcript && p.source !== 'fixture' && <span className="dayplan__quote"> “{p.draft.transcript}”</span>}
      </div>
    </section>
  )
}
