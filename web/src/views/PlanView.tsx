import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { ContractDrill } from '../data/llmPlan'
import { PRACTICE_START_HOUR, ROSTER, contractToUi } from '../data/fixtures'
import { THRESHOLDS, zoneFor, ZONE_COLOR } from '../data/constants'
import { peakOf, wbgtAt } from '../data/model'
import { checkRules, forecastRoster } from '../data/optimizer'
import { perMinute, type SimulationResult } from '../data/engineApi'
import { planStore, usePlanState } from '../data/planStore'
import { PlanEditor } from '../components/PlanEditor'
import { NumberTicker } from '../components/NumberTicker'
import { IconCheck, IconClose, IconSpark } from '../components/Icons'
import { clockLabel, heatColor } from '../lib/heat'
import { AI_NAME } from '../lib/brand'
import { useWeather } from '../data/weather'
import type { WeatherHour } from '../data/types'
import { ease, spring } from '../lib/motion'
import './PlanView.css'

// Today's plan — the same plan the live roster and every athlete page use
// (voice, edited, optimized, or the default). Heat comes from the engine's
// /simulate result when there is one, else the browser-side stand-in model.
// Click a block for its details; Edit opens the timeline editor.

const CELL_MIN = 2
const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }
const INTENSITY: Record<string, string> = { rest: 'Rest', light: 'Light', moderate: 'Moderate', hard: 'Hard', max: 'Max' }
const PRIORITY: Record<number, string> = { 1: 'Must keep', 2: 'Normal', 3: 'Optional' }

interface Forecasts {
  /** athleteId → p95 core temp per minute */
  series: Record<string, number[]>
  limit: number
  violations: { drill_id: string; text: string }[]
  fromEngine: boolean
}

function fromSim(sim: SimulationResult, minutes: number): Forecasts {
  return {
    series: Object.fromEntries(sim.athletes.map((a) => [a.id, perMinute(a.core_c_p95, sim.step_min, minutes)])),
    limit: sim.limit_core_c,
    violations: sim.fhsaa_violations.map((v) => ({ drill_id: v.drill_id, text: v.detail })),
    fromEngine: true,
  }
}

export function PlanView() {
  const p = usePlanState()
  const weather = useWeather()
  const forecast = weather.forecast
  const reduce = useReducedMotion()
  const [editing, setEditing] = useState(false)
  const [editFrom, setEditFrom] = useState<string | null>(null)
  const [openDrill, setOpenDrill] = useState<string | null>(null)
  const saveRequested = useRef(false)

  const drills = p.plan.drills
  const minutes = Math.round(drills.reduce((s, d) => s + d.duration_min, 0))
  const uiPlan = useMemo(() => contractToUi(p.plan), [p.plan])

  const now: Forecasts = useMemo(() => {
    if (p.sim && !weather.location) return fromSim(p.sim, minutes)
    return {
      series: forecastRoster(ROSTER, uiPlan, forecast, PRACTICE_START_HOUR),
      limit: THRESHOLDS.alertC,
      violations: checkRules(uiPlan, forecast, PRACTICE_START_HOUR).map((v) => ({ drill_id: 'plan', text: v.text })),
      fromEngine: false,
    }
  }, [p.sim, minutes, uiPlan, forecast, weather.location])

  const before = p.opt ? fromSim(p.opt.original, Math.max(1, p.opt.original.times.length - 1)) : null

  const over = (f: Forecasts) => ROSTER.filter((a) => f.series[a.id] && peakOf(f.series[a.id]).value >= f.limit).length
  const hottest = (f: Forecasts) => Math.max(...ROSTER.map((a) => (f.series[a.id] ? peakOf(f.series[a.id]).value : 0)))

  // Leave edit mode once the edited plan has been modeled.
  useEffect(() => {
    if (saveRequested.current && p.phase === 'ready' && p.source === 'edited') {
      saveRequested.current = false
      setEditing(false) // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [p.phase, p.source])

  const cols = Math.ceil(minutes / CELL_MIN)
  const startHour = hourOf(p.plan.start)
  const busy = p.phase === 'simulating' || p.phase === 'optimizing'

  const startEdit = (from: string | null = null) => {
    setOpenDrill(null)
    setEditFrom(from)
    setEditing(true)
  }

  return (
    <div className="plan">
      <header className="plan__head">
        <div>
          <div className="eyebrow">
            Today · {clockLabel(startHour, 0)} – {clockLabel(startHour, minutes)} · <SourceLabel source={p.source} />
          </div>
          <h1 className="display-lg">Practice plan</h1>
        </div>
        {!editing && (
          <div className="plan__actions">
            {p.previous && (
              <button className="btn btn--quiet pressable" onClick={() => planStore.undo()} disabled={busy}>
                Undo {p.source === 'optimized' ? 'optimization' : 'last change'}
              </button>
            )}
            <button className="btn btn--quiet btn--lg pressable" onClick={() => startEdit()} disabled={busy}>
              Edit
            </button>
            <button
              className="btn btn--ink btn--lg pressable"
              onClick={() => planStore.optimize()}
              disabled={busy || p.source === 'optimized'}
            >
              {p.phase === 'optimizing' ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Optimizing…
                </>
              ) : p.source === 'optimized' ? (
                <>
                  <IconCheck width={18} height={18} /> Optimized
                </>
              ) : (
                <>
                  <IconSpark width={18} height={18} /> Optimize plan
                </>
              )}
            </button>
          </div>
        )}
      </header>

      {p.phase === 'error' && !editing && (
        <div className="plan__error" role="alert">
          {p.error}
          <button className="linkbtn" onClick={() => planStore.dismissError()}>
            Dismiss
          </button>
        </div>
      )}

      <div className="plan__summary">
        <Metric label="Forecast over the line" value={over(now)} was={before ? over(before) : null} unit="athletes" />
        <Metric label="Hottest forecast (p95)" value={hottest(now)} was={before ? hottest(before) : null} unit="°" decimals={1} />
        <Metric label="FHSAA issues" value={now.violations.length} was={before ? before.violations.length : null} />
        <Metric label="Training load kept" value={p.opt ? Math.round(p.opt.load_kept_pct) : 100} was={p.opt ? 100 : null} unit="%" neutral />
      </div>

      <section className="glass plan__board">
        <AnimatePresence mode="popLayout" initial={false}>
          {editing ? (
            <motion.div
              key="editor"
              initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
              transition={{ duration: 0.26, ease: ease.out }}
            >
              <PlanEditor
                initial={drills}
                startHour={startHour}
                initialSelected={editFrom}
                saving={p.phase === 'simulating'}
                error={p.phase === 'error' ? p.error : null}
                onCancel={() => {
                  planStore.dismissError()
                  setEditing(false)
                }}
                onSave={(edited) => {
                  saveRequested.current = true
                  planStore.applyPlan({ ...p.plan, id: 'plan-edited', drills: edited })
                }}
              />
            </motion.div>
          ) : (
            <motion.div
              key="view"
              initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
              animate={{ opacity: 1, filter: 'blur(0px)' }}
              exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
              transition={{ duration: 0.26, ease: ease.out }}
            >
              <div className="plan__rules">
                <AnimatePresence mode="popLayout" initial={false}>
                  {now.violations.length === 0 ? (
                    <motion.span
                      key="ok"
                      className="rule rule--ok"
                      initial={{ opacity: 0, transform: 'scale(0.95)' }}
                      animate={{ opacity: 1, transform: 'scale(1)' }}
                      exit={{ opacity: 0, transform: 'scale(0.95)' }}
                      transition={{ duration: 0.2, ease: ease.out }}
                    >
                      <IconCheck width={14} height={14} /> Meets FHSAA {zoneFor(peakWbgt(forecast, startHour, minutes)).id} zone rules
                    </motion.span>
                  ) : (
                    now.violations.slice(0, 4).map((v, i) => (
                      <motion.span
                        key={`${i}-${v.text}`}
                        className="rule rule--bad"
                        title={v.text}
                        initial={{ opacity: 0, transform: 'scale(0.95)' }}
                        animate={{ opacity: 1, transform: 'scale(1)' }}
                        exit={{ opacity: 0, transform: 'scale(0.95)' }}
                        transition={{ duration: 0.2, ease: ease.out }}
                      >
                        {shorten(v.text)}
                      </motion.span>
                    ))
                  )}
                </AnimatePresence>
                {now.violations.length > 4 && <span className="rule rule--bad">+{now.violations.length - 4} more</span>}
              </div>

              <div className="plan__grid" style={{ ['--cols' as string]: cols }}>
                <div className="plan__label plan__label--head">Drill</div>
                <LayoutGroup>
                  <div className="timeline">
                    <AnimatePresence initial={false}>
                      {drills.map((d) => (
                        <DrillBlock
                          key={d.id}
                          d={d}
                          total={minutes}
                          open={openDrill === d.id}
                          onClick={() => setOpenDrill((o) => (o === d.id ? null : d.id))}
                          reduce={!!reduce}
                        />
                      ))}
                    </AnimatePresence>
                    <AnimatePresence>
                      {openDrill && (
                        <DrillPopover
                          key={openDrill}
                          drills={drills}
                          id={openDrill}
                          total={minutes}
                          startHour={startHour}
                          f={now}
                          onClose={() => setOpenDrill(null)}
                          onEdit={() => startEdit(openDrill)}
                        />
                      )}
                    </AnimatePresence>
                  </div>
                </LayoutGroup>
                <div />

                <div className="plan__label">WBGT</div>
                <div className="wbgt">
                  {Array.from({ length: cols }, (_, c) => {
                    const z = zoneFor(wbgtAt(forecast, startHour + (c * CELL_MIN) / 60))
                    return <span key={c} style={{ background: ZONE_COLOR[z.id] }} />
                  })}
                </div>
                <div />

                {ROSTER.map((a) => {
                  const f = now.series[a.id] ?? []
                  const peak = f.length ? peakOf(f).value : 0
                  return (
                    <div className="strip-row" key={a.id}>
                      <div className="plan__label">
                        <span className="num plan__num">{a.number}</span>
                        <span className="plan__name">{a.name}</span>
                      </div>
                      <div className="strip">
                        {Array.from({ length: cols }, (_, c) => {
                          const v = f[Math.min(f.length - 1, c * CELL_MIN)] ?? THRESHOLDS.baselineC
                          return (
                            <span
                              key={c}
                              className={v >= now.limit ? 'is-over' : ''}
                              // Column-wise sweep, 6ms apart — the change reads as one wave through the session.
                              style={{ background: heatColor(v), transitionDelay: reduce ? '0ms' : `${c * 6}ms` }}
                            />
                          )
                        })}
                      </div>
                      <div className={`plan__peak num ${peak >= now.limit ? 'is-over' : ''}`}>
                        <NumberTicker value={peak} decimals={1} suffix="°" />
                      </div>
                    </div>
                  )
                })}

                <div />
                <div className="plan__axis num">
                  {Array.from({ length: Math.floor(minutes / 15) + 1 }, (_, i) => (
                    <span key={i} style={{ left: `${((i * 15) / Math.max(1, minutes)) * 100}%` }}>
                      {clockLabel(startHour, i * 15).replace(/ (AM|PM)/, '')}
                    </span>
                  ))}
                </div>
                <div />
              </div>
              <p className="faint plan__note">
                {now.fromEngine
                  ? 'Heat strip: engine p95 core-temperature estimate per athlete — planning only. Click any block for details.'
                  : `Heat strip: browser stand-in model. Ask ${AI_NAME} or save an edit to model it on the engine.`}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {p.opt && !editing && p.source === 'optimized' && (
          <motion.section
            className="glass plan__changes"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)', filter: 'blur(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)', transition: { duration: 0.15 } }}
            transition={{ duration: 0.32, ease: ease.out }}
          >
            <div className="eyebrow">What {AI_NAME} changed</div>
            {p.opt.top_changes_text && <p className="plan__top">{p.opt.top_changes_text}</p>}
            <ul>
              {p.opt.changes.map((c, i) => (
                <motion.li
                  key={`${c.drill_id}-${i}`}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px)' }}
                  transition={{ duration: 0.28, ease: ease.out, delay: 0.1 + i * 0.04 }}
                >
                  <span className="change">{(c.move ?? c.kind).replace(/_/g, ' ')}</span>
                  {c.detail}
                </motion.li>
              ))}
            </ul>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}

function SourceLabel({ source }: { source: string }) {
  const label: Record<string, string> = {
    fixture: 'Default plan',
    voice: `From ${AI_NAME}`,
    optimized: `Optimized by ${AI_NAME}`,
    edited: 'Edited',
  }
  return <span className={`plan__src plan__src--${source}`}>{label[source]}</span>
}

function hourOf(iso: string) {
  const m = /T(\d{2}):(\d{2})/.exec(iso)
  return m ? Number(m[1]) + Number(m[2]) / 60 : PRACTICE_START_HOUR
}

function peakWbgt(forecast: WeatherHour[], startHour: number, minutes: number) {
  let p = 0
  for (let m = 0; m <= minutes; m += 5) p = Math.max(p, wbgtAt(forecast, startHour + m / 60))
  return p
}

/** Engine violation details are long; turn "Hour 2026-10-04T15:00:00-04:00: …" into "3 PM hour: …" and trim. */
function shorten(t: string) {
  const hour = /^Hour \S*T(\d\d):\S*\s+(.*)$/.exec(t)
  let s = hour ? `${((Number(hour[1]) + 11) % 12) + 1} ${Number(hour[1]) >= 12 ? 'PM' : 'AM'} hour: ${hour[2]}` : t.split(/[:;]/)[0]
  s = s.trim()
  return s.length > 64 ? `${s.slice(0, 62)}…` : s
}

function DrillBlock({
  d,
  total,
  open,
  onClick,
  reduce,
}: {
  d: ContractDrill
  total: number
  open: boolean
  onClick: () => void
  reduce: boolean
}) {
  const kind = d.is_break ? 'break' : d.intensity
  return (
    <motion.button
      layout={!reduce}
      className={`block block--${kind} ${open ? 'is-open' : ''}`}
      style={{ flexGrow: d.duration_min, flexBasis: 0 }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.9)' }}
      animate={{ opacity: 1, transform: 'scale(1)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.9)', transition: { duration: 0.15 } }}
      transition={{ layout: spring.move, duration: 0.24, ease: ease.out }}
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${d.name}, ${d.duration_min} minutes. Show details.`}
      data-drill={d.id}
    >
      {d.duration_min / total > 0.06 && (
        <motion.span layout="position" className="block__text">
          <span className="block__name">{d.is_break ? 'Water' : d.name.charAt(0).toUpperCase() + d.name.slice(1)}</span>
          <span className="block__min num">
            {d.duration_min}′ · {GEAR[d.gear].toLowerCase()}
          </span>
        </motion.span>
      )}
    </motion.button>
  )
}

/** Details for one drill, growing out of the block that opened it. */
function DrillPopover({
  drills,
  id,
  total,
  startHour,
  f,
  onClose,
  onEdit,
}: {
  drills: ContractDrill[]
  id: string
  total: number
  startHour: number
  f: Forecasts
  onClose: () => void
  onEdit: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const i = drills.findIndex((d) => d.id === id)
  const d = drills[i]
  const start = drills.slice(0, i).reduce((s, x) => s + x.duration_min, 0)
  const end = start + (d?.duration_min ?? 0)
  const centre = ((start + end) / 2 / Math.max(1, total)) * 100
  // Keep the panel inside the board; the transform-origin stays on the block.
  const left = Math.max(16, Math.min(84, centre))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t) || t.closest(`[data-drill="${id}"]`)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [id, onClose])

  if (!d) return null

  const inBlock = ROSTER.map((a) => {
    const s = f.series[a.id] ?? []
    const seg = s.slice(Math.round(start), Math.round(end) + 1)
    return { a, peak: seg.length ? Math.max(...seg) : 0 }
  }).sort((x, y) => y.peak - x.peak)
  const overCount = inBlock.filter((x) => x.peak >= f.limit).length
  const lighter = d.gear_by_athlete ? Object.keys(d.gear_by_athlete).length : 0
  const issues = f.violations.filter((v) => v.drill_id === d.id)
  // Origin-aware: grow from the block's centre even when the panel is nudged to stay on screen.
  const originX = Math.max(8, Math.min(92, 50 + (centre - left) * 4))

  return (
    <motion.div
      ref={ref}
      className="pop glass glass--strong"
      role="dialog"
      aria-label={`${d.name} details`}
      style={{ left: `${left}%`, transformOrigin: `${originX}% 0%` }}
      initial={{ opacity: 0, transform: 'translateX(-50%) scale(0.95)' }}
      animate={{ opacity: 1, transform: 'translateX(-50%) scale(1)' }}
      exit={{ opacity: 0, transform: 'translateX(-50%) scale(0.95)', transition: { duration: 0.14 } }}
      transition={{ duration: 0.2, ease: ease.out }}
    >
      <div className="pop__head">
        <div>
          <div className="eyebrow num">
            {clockLabel(startHour, start)} – {clockLabel(startHour, end)} · {d.duration_min} min
          </div>
          <div className="display-sm">{d.name.charAt(0).toUpperCase() + d.name.slice(1)}</div>
        </div>
        <button className="pop__close pressable" onClick={onClose} aria-label="Close">
          <IconClose width={16} height={16} />
        </button>
      </div>

      <div className="pop__chips">
        {!d.is_break && <span className={`chip chip--${d.intensity}`}>{INTENSITY[d.intensity]}</span>}
        <span className="chip">{GEAR[d.gear]}</span>
        {d.is_break && <span className="chip">{d.shade ? 'In shade' : 'Break'}</span>}
        <span className="chip">{PRIORITY[d.priority]}</span>
        {!d.movable && <span className="chip">Locked in place</span>}
      </div>
      {lighter > 0 && <p className="pop__note">{lighter} athletes wear lighter gear here (acclimatization limits).</p>}

      {!d.is_break && (
        <div className="pop__heat">
          <div className="eyebrow">
            Hottest in this block · {overCount > 0 ? `${overCount} over ${f.limit.toFixed(1)}°` : `all under ${f.limit.toFixed(1)}°`}
          </div>
          <ul>
            {inBlock.slice(0, 3).map(({ a, peak }) => (
              <li key={a.id}>
                <span className="pop__dot" style={{ background: heatColor(peak) }} />
                <span>{a.name}</span>
                <span className={`num ${peak >= f.limit ? 'is-over' : ''}`}>{peak.toFixed(1)}°</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <ul className="pop__issues">
          {issues.map((v, k) => (
            <li key={k}>{shorten(v.text)}</li>
          ))}
        </ul>
      )}

      <div className="pop__actions">
        <button className="btn btn--ink pressable" onClick={onEdit}>
          Edit this drill
        </button>
      </div>
    </motion.div>
  )
}

function Metric({
  label,
  value,
  was,
  unit = '',
  decimals = 0,
  neutral = false,
}: {
  label: string
  value: number
  was: number | null
  unit?: string
  decimals?: number
  neutral?: boolean
}) {
  const better = was != null && value < was
  const word = unit === 'athletes'
  return (
    <div className={`glass metric ${!neutral && better ? 'is-better' : ''}`}>
      <div className="eyebrow">{label}</div>
      <div className="metric__value display-md">
        <NumberTicker value={value} decimals={decimals} suffix={word ? '' : unit} />
        {word && <span className="metric__unit">athletes</span>}
      </div>
      <div className="metric__was faint num">{was != null ? `was ${was.toFixed(decimals)}${word ? '' : unit}` : 'current plan'}</div>
    </div>
  )
}
