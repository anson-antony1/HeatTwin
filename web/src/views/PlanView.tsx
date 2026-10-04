import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { ContractDrill } from '../data/llmPlan'
import { zoneColor } from '../data/constants'
import type { SimulationResult } from '../data/engineApi'
import { planStore, usePlanState } from '../data/planStore'
import { SYNTHETIC_ROSTER_LABEL, useRoster } from '../data/roster'
import { hottestPeakP95, hourOf, maxBetween, overCount, peakZone, valueAtMinute, weatherHourAt } from '../data/selectors'
import { PlanEditor } from '../components/PlanEditor'
import { NumberTicker } from '../components/NumberTicker'
import { OfflineBadge } from '../components/OfflineBadge'
import { IconCheck, IconClose, IconSpark } from '../components/Icons'
import { clockLabel, heatColor } from '../lib/heat'
import { AI_NAME } from '../lib/brand'
import { coreValue, fmtCore, fmtLimit, PEAK_DECIMALS } from '../lib/format'
import { ease, spring } from '../lib/motion'
import './PlanView.css'

// Today's plan — the same plan the live roster and every athlete page use
// (voice, edited, optimized, or the engine's demo plan). Every heat number is
// the engine's /simulate (or /optimize) result for this plan; with the engine
// unreachable the plan structure stays and every number reads "—".
// Click a block for its details; Edit opens the timeline editor.

const CELL_MIN = 2
const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }
const INTENSITY: Record<string, string> = { rest: 'Rest', light: 'Light', moderate: 'Moderate', hard: 'Hard', max: 'Max' }
const PRIORITY: Record<number, string> = { 1: 'Must keep', 2: 'Normal', 3: 'Optional' }

interface Forecasts {
  sim: SimulationResult | null
  limit: number | null
  violations: { drill_id: string; text: string }[]
  /** Athletes estimated over the line (engine status), hottest p95 peak, FHSAA issues — null without a result. */
  over: number | null
  hottest: number | null
  issues: number | null
}

function fromSim(sim: SimulationResult | null): Forecasts {
  return {
    sim,
    limit: sim?.limit_core_c ?? null,
    violations: sim ? sim.fhsaa_violations.map((v) => ({ drill_id: v.drill_id, text: v.detail })) : [],
    over: overCount(sim),
    hottest: hottestPeakP95(sim),
    issues: sim ? sim.fhsaa_violations.length : null,
  }
}

/** One athlete's p95 at a practice minute, from the engine result. */
function p95At(f: Forecasts, id: string, m: number): number | null {
  const a = f.sim?.athletes.find((x) => x.id === id)
  return a && f.sim ? valueAtMinute(a.core_c_p95, f.sim.step_min, m) : null
}

/** Peak p95 shown with the 2-decimal formatter (rounded like the engine), as a NumberTicker value. */
const peakValue = (v: number | null, limit: number | null) => (v == null ? Number.NaN : coreValue(v, limit, PEAK_DECIMALS))

export function PlanView() {
  const p = usePlanState()
  const roster = useRoster()
  const reduce = useReducedMotion()
  const [editing, setEditing] = useState(false)
  const [editFrom, setEditFrom] = useState<string | null>(null)
  const [openDrill, setOpenDrill] = useState<string | null>(null)
  const saveRequested = useRef(false)

  const drills = p.plan.drills
  const minutes = Math.round(drills.reduce((s, d) => s + d.duration_min, 0))

  const now: Forecasts = useMemo(() => fromSim(p.sim), [p.sim])
  const before = p.opt ? fromSim(p.opt.original) : null

  // Leave edit mode once the edited plan has been modeled.
  useEffect(() => {
    if (saveRequested.current && p.phase === 'ready' && p.source === 'edited') {
      saveRequested.current = false
      setEditing(false) // eslint-disable-line react-hooks/set-state-in-effect
    }
  }, [p.phase, p.source])

  const cols = Math.ceil(minutes / CELL_MIN)
  const startHour = hourOf(p.plan.start) ?? 0
  const busy = p.phase === 'simulating' || p.phase === 'optimizing'
  const zoneNow = p.sim ? peakZone(p.sim.weather, p.plan.start, minutes) : null

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
            {p.offline && <> <OfflineBadge /></>}
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
        <Metric label="Forecast over the line" value={now.over} was={before ? before.over : null} unit="athletes" />
        <Metric
          label="Hottest forecast (p95)"
          value={peakValue(now.hottest, now.limit)}
          was={before ? peakValue(before.hottest, before.limit) : null}
          unit="°"
          decimals={PEAK_DECIMALS}
        />
        <Metric label="FHSAA issues" value={now.issues} was={before ? before.issues : null} />
        <Metric
          label="Training load kept"
          value={p.opt ? Math.round(p.opt.load_kept_pct) : p.sim ? 100 : null}
          was={p.opt ? 100 : null}
          unit="%"
          neutral
        />
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
                  {!now.sim ? (
                    <motion.span key="none" className="rule" initial={false}>
                      FHSAA rules: —
                    </motion.span>
                  ) : now.violations.length === 0 ? (
                    <motion.span
                      key="ok"
                      className="rule rule--ok"
                      initial={{ opacity: 0, transform: 'scale(0.95)' }}
                      animate={{ opacity: 1, transform: 'scale(1)' }}
                      exit={{ opacity: 0, transform: 'scale(0.95)' }}
                      transition={{ duration: 0.2, ease: ease.out }}
                    >
                      <IconCheck width={14} height={14} /> Meets FHSAA zone {zoneNow ?? '—'} rules
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
                    const h = weatherHourAt(p.sim?.weather, p.plan.start, c * CELL_MIN)
                    return <span key={c} style={{ background: zoneColor(h?.fhsaa_zone) }} title={h ? `${h.wbgt_f.toFixed(1)} °F · zone ${h.fhsaa_zone}` : undefined} />
                  })}
                </div>
                <div />

                {roster.athletes.map((a) => {
                  const simA = now.sim?.athletes.find((x) => x.id === a.id)
                  const peak = simA ? simA.peak_core_c_p95 : null
                  const over = (v: number | null) => v != null && now.limit != null && v >= now.limit
                  return (
                    <div className="strip-row" key={a.id}>
                      <div className="plan__label">
                        <span className="num plan__num">{a.position ?? '—'}</span>
                        <span className="plan__name">{roster.name(a.id)}</span>
                      </div>
                      <div className="strip">
                        {Array.from({ length: cols }, (_, c) => {
                          const v = p95At(now, a.id, c * CELL_MIN)
                          return (
                            <span
                              key={c}
                              className={over(v) ? 'is-over' : ''}
                              // Column-wise sweep, 6ms apart — the change reads as one wave through the session.
                              style={{ background: v != null ? heatColor(v) : 'var(--ink-4)', transitionDelay: reduce ? '0ms' : `${c * 6}ms` }}
                            />
                          )
                        })}
                      </div>
                      <div className={`plan__peak num ${over(peak) ? 'is-over' : ''}`}>
                        <NumberTicker value={peakValue(peak, now.limit)} decimals={PEAK_DECIMALS} suffix="°" />
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
                {now.sim
                  ? `Heat strip: engine p95 core-temperature estimate per athlete — planning only.${roster.synthetic ? ` ${SYNTHETIC_ROSTER_LABEL[0].toUpperCase()}${SYNTHETIC_ROSTER_LABEL.slice(1)}.` : ''} Click any block for details.`
                  : p.offline
                    ? 'Heat strip: offline fallback — the engine is unreachable, so no estimates are shown.'
                    : 'Heat strip: waiting for the engine…'}
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
  const roster = useRoster()
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

  const inBlock = roster.athletes
    .map((a) => {
      const simA = f.sim?.athletes.find((x) => x.id === a.id)
      return { a, peak: simA && f.sim ? maxBetween(simA.core_c_p95, f.sim.step_min, start, end) : null }
    })
    .sort((x, y) => (y.peak ?? -Infinity) - (x.peak ?? -Infinity))
  const isOver = (v: number | null) => v != null && f.limit != null && v >= f.limit
  const overInBlock = inBlock.filter((x) => isOver(x.peak)).length
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
            Hottest in this block ·{' '}
            {!f.sim ? '—' : overInBlock > 0 ? `${overInBlock} over ${fmtLimit(f.limit)}°` : `all under ${fmtLimit(f.limit)}°`}
          </div>
          <ul>
            {inBlock.slice(0, 3).map(({ a, peak }) => (
              <li key={a.id}>
                <span className="pop__dot" style={{ background: peak != null ? heatColor(peak) : 'var(--ink-4)' }} />
                <span>{roster.name(a.id)}</span>
                <span className={`num ${isOver(peak) ? 'is-over' : ''}`}>{fmtCore(peak, f.limit)}°</span>
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
  /** Engine number; null / NaN prints "—". */
  value: number | null
  was: number | null
  unit?: string
  decimals?: number
  neutral?: boolean
}) {
  const shown = value ?? Number.NaN
  const better = was != null && value != null && value < was
  const word = unit === 'athletes'
  return (
    <div className={`glass metric ${!neutral && better ? 'is-better' : ''}`}>
      <div className="eyebrow">{label}</div>
      <div className="metric__value display-md">
        <NumberTicker value={shown} decimals={decimals} suffix={word ? '' : unit} />
        {word && <span className="metric__unit">athletes</span>}
      </div>
      <div className="metric__was faint num">
        {was != null && Number.isFinite(was) ? `was ${was.toFixed(decimals)}${word ? '' : unit}` : 'current plan'}
      </div>
    </div>
  )
}
