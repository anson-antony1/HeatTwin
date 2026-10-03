import { useEffect, useRef, useState } from 'react'
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { usePlan, useSession } from '../data/engine'
import { ROSTER } from '../data/fixtures'
import { SAFETY_LINE, THRESHOLDS } from '../data/constants'
import { bodySurfaceArea, drillAt } from '../data/model'
import { BodyFigure } from '../components/BodyFigure'
import { NumberTicker } from '../components/NumberTicker'
import { StatusPill } from '../components/StatusPill'
import { TempChart } from '../components/TempChart'
import { IconDrop, IconHeart, IconResponse } from '../components/Icons'
import { clockLabel, cToF, gearLabel, heatColor } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { gearFor, usePlanState } from '../data/planStore'
import { perMinute } from '../data/engineApi'
import { AI_NAME } from '../lib/brand'
import './AthleteView.css'

interface Props {
  athleteId: string
  onSelect: (id: string) => void
  onCollapse: (id: string) => void
}

export function AthleteView({ athleteId, onSelect, onCollapse }: Props) {
  const reduce = useReducedMotion()
  return (
    <div className="twin">
      <header className="twin__head">
        <div>
          <div className="eyebrow">Athlete twin</div>
          <h1 className="display-lg">Heat forecast</h1>
        </div>
        <Picker athleteId={athleteId} onSelect={onSelect} />
      </header>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={athleteId}
          initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
          transition={{ duration: 0.28, ease: ease.out }}
        >
          <TwinBody athleteId={athleteId} onCollapse={onCollapse} />
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function Picker({ athleteId, onSelect }: { athleteId: string; onSelect: (id: string) => void }) {
  const s = useSession()
  return (
    <div className="picker glass" role="tablist" aria-label="Choose athlete">
      {ROSTER.map((a) => {
        const on = a.id === athleteId
        const status = s.athletes[a.id].status
        return (
          <button
            key={a.id}
            role="tab"
            aria-selected={on}
            className={`picker__chip num ${on ? 'is-on' : ''} picker__chip--${status}`}
            onClick={() => onSelect(a.id)}
            title={a.name}
          >
            {on && <motion.span layoutId="picker-thumb" className="picker__thumb" transition={spring.ui} />}
            <span className="picker__label">{a.number}</span>
            {status !== 'steady' && <span className="picker__flag" aria-label={status} />}
          </button>
        )
      })}
    </div>
  )
}

function TwinBody({ athleteId, onCollapse }: { athleteId: string; onCollapse: (id: string) => void }) {
  const s = useSession()
  const plan = usePlan()
  const a = ROSTER.find((r) => r.id === athleteId)!
  const live = s.athletes[a.id]
  const { drill } = drillAt(plan, s.minute)
  const calibrated = a.hasStrap && s.minute > 5
  const nextBand = live.band.find((b) => b > 0) ?? 0

  // Scrubbing the chart drives the whole page: figure, number, and labels read
  // the scrubbed minute until the coach lets go (mouse) or taps "Live".
  const [scrub, setScrub] = useState<number | null>(null)
  const scrubbed = scrub != null ? readAt(live, s.minute, scrub) : null
  const coreShown = scrubbed ? scrubbed.c : live.coreC
  const zoom = useZoom(s.totalMinutes, scrub ?? s.minute)

  return (
    <div className="twin__grid">
      {/* Vitals — the Figma's tall left card */}
      <section className="glass card vitals">
        <div className="vitals__who">
          <span className="vitals__num num">{a.number}</span>
          <div>
            <div className="display-sm">{a.name}</div>
            <div className="faint" style={{ fontSize: 13 }}>
              {a.position} · {a.massKg} kg · {a.heightCm} cm
            </div>
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
                  : 'Estimated core'}
              </motion.span>
            </AnimatePresence>
            {scrubbed && (
              <button className="vitals__live pressable" onClick={() => setScrub(null)}>
                Live
              </button>
            )}
          </div>
          <div className="display-xl vitals__temp" style={{ color: heatColor(coreShown) }}>
            <NumberTicker value={coreShown} decimals={1} suffix="°C" />
          </div>
          <div className="muted num" style={{ fontSize: 14 }}>
            {cToF(coreShown).toFixed(1)} °F · ±{(scrubbed ? scrubbed.band : nextBand).toFixed(2)}° (p95)
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
                <span className="faint">No strap paired</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Forecast peak</dt>
            <dd className="num">
              {live.predictedPeakC.toFixed(1)}° at {clockLabel(s.startHour, live.predictedPeakMin)}
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>
              {s.forecastSource === 'engine' ? 'Engine · ' : ''}
              {calibrated ? 'calibrated from live HR' : a.hasStrap ? 'calibrating…' : 'plan forecast only'}
            </dd>
          </div>
        </dl>

        {live.status === 'alert' && (
          <button className="btn btn--alert pressable vitals__cta" onClick={() => onCollapse(a.id)}>
            <IconResponse width={18} height={18} /> Collapse response
          </button>
        )}
      </section>

      {/* The twin itself */}
      <section className="twin__figure" aria-label="Thermal figure">
        <BodyFigure coreC={coreShown} hr={scrubbed ? null : live.hr} />
        <div className="twin__callout twin__callout--core">
          <span className="twin__callout-dot" style={{ background: heatColor(coreShown) }} />
          Core
        </div>
        {live.hr != null && !scrubbed && (
          <div className="twin__callout twin__callout--hr">
            <span className="twin__callout-dot" />
            Heart · strap
          </div>
        )}
      </section>

      {/* Today — top-right card */}
      <section className="glass card today">
        <div className="today__now">
          <div className="eyebrow">Now</div>
          <div className="display-sm">{drill.name}</div>
          <div className="muted" style={{ fontSize: 13.5 }}>
            {gearLabel(drill.gear)} ·{' '}
            <span className="num">{Math.ceil(s.drillMinuteLeft)}</span> min left
          </div>
        </div>
        <BreakRing minutes={s.nextBreakIn} />
      </section>

      {/* Forecast — tall right card */}
      <section className="glass card forecast">
        <div className="forecast__head">
          <div>
            <div className="eyebrow">Core temperature · this session</div>
            <div className="display-sm">
              {live.predictedPeakC >= THRESHOLDS.alertC ? 'Forecast crosses the line' : 'Forecast stays under the line'}
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
            drills={plan}
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
              <Navigator series={live.forecast} total={s.totalMinutes} view={zoom.view} onPan={zoom.panTo} />
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
              Day <span className="num">{a.acclimDay}</span> of 14
            </div>
          </div>
          <div className="acclim__bsa faint num">BSA {bodySurfaceArea(a).toFixed(2)} m²</div>
        </div>
        <div className="acclim__bar" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span
              key={i}
              className={i < a.acclimDay ? 'is-on' : ''}
              style={{ transitionDelay: `${i * 30}ms` }}
            />
          ))}
        </div>
        <p className="acclim__note muted">
          {a.acclimDay <= 5
            ? 'Early days carry the most risk — the body hasn’t yet learned to sweat sooner and more.'
            : 'Sweat response is adapting. Keep breaks; acclimatization fades after a few days off.'}
        </p>
      </section>

      <AthletePlanCard athleteId={a.id} minute={s.minute} />

      <p className="twin__safety faint">{SAFETY_LINE}</p>
    </div>
  )
}

function BreakRing({ minutes }: { minutes: number | null }) {
  const window = 15
  const r = 30
  const c = 2 * Math.PI * r
  const onBreak = minutes === 0
  const frac = minutes == null ? 0 : onBreak ? 1 : Math.max(0, 1 - minutes / window)
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
function readAt(live: { history: number[]; forecast: number[]; band: number[]; coreC: number }, now: number, m: number) {
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
}: {
  series: number[]
  total: number
  view: [number, number]
  onPan: (center: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const grab = useRef<number | null>(null)
  const lo = 36.8
  const hi = 39.6
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

const PLAN_GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }

/** Today's plan as this athlete will live it: their gear, their engine forecast per block. */
function AthletePlanCard({ athleteId, minute }: { athleteId: string; minute: number }) {
  const p = usePlanState()
  const reduce = useReducedMotion()
  const drills = p.plan.drills
  const total = drills.reduce((sum, d) => sum + d.duration_min, 0)
  const simA = p.sim?.athletes.find((x) => x.id === athleteId)
  const p95 = simA && p.sim ? perMinute(simA.core_c_p95, p.sim.step_min, Math.round(total)) : null
  const limit = p.sim?.limit_core_c ?? THRESHOLDS.alertC

  const source =
    p.source === 'voice'
      ? `Described by voice${p.confirmedAt ? ` · ${new Date(p.confirmedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}`
      : p.source === 'optimized'
        ? `Optimized by ${AI_NAME}`
        : p.source === 'edited'
          ? 'Edited by the coach'
          : 'Default plan'

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
          <div className="eyebrow">Today’s plan · from Coach Reyes</div>
          <div className="display-sm">
            {simA
              ? simA.first_cross_min != null
                ? `Forecast crosses ${limit.toFixed(1)}° at minute ${Math.round(simA.first_cross_min)}`
                : `Forecast stays under ${limit.toFixed(1)}° · peak ${simA.peak_core_c_p95.toFixed(1)}°`
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
              style={{ flexGrow: d.duration_min, flexBasis: 0, ['--heat' as string]: peak != null && !d.is_break ? heatColor(peak) : undefined }}
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
              animate={{ opacity: 1, transform: 'translateY(0px)' }}
              transition={{ duration: 0.28, ease: ease.out, delay: i * 0.035 }}
              title={`${d.name} · ${d.duration_min} min · ${PLAN_GEAR[gear]}${peak != null ? ` · peak ${peak.toFixed(1)}°` : ''}`}
            >
              {d.duration_min / total > 0.07 && (
                <span className="dayblock__text">
                  <span className="dayblock__name">{d.is_break ? 'Water' : d.name.charAt(0).toUpperCase() + d.name.slice(1)}</span>
                  <span className="dayblock__meta num">
                    {d.duration_min}′{!d.is_break && ` · ${sitsOut ? 'sits out' : PLAN_GEAR[gear]}`}
                  </span>
                </span>
              )}
              {peak != null && !d.is_break && d.duration_min / total > 0.07 && (
                <span className={`dayblock__peak num ${peak >= limit ? 'is-over' : ''}`}>{peak.toFixed(1)}°</span>
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
          ? 'Peak per block is the engine’s p95 estimate for this athlete — planning only.'
          : 'Tap the mic and describe today’s practice to model it on the engine.'}
        {p.draft?.transcript && p.source !== 'fixture' && <span className="dayplan__quote"> “{p.draft.transcript}”</span>}
      </div>
    </section>
  )
}
