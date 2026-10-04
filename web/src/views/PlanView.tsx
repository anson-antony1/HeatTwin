import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { ContractDrill } from '../data/llmPlan'
import type { AthleteStatus, OptimizePreset, SimulationResult, WeatherHour } from '../data/engineApi'
import { zoneColor } from '../data/constants'
import { planStore, usePlanState } from '../data/planStore'
import { useRoster } from '../data/roster'
import { useEngineMeta } from '../data/engineMeta'
import {
  FHSAA_CITATION,
  fewestChangesNote,
  hottestPeakP95,
  hourOf,
  planMinutes,
  seriesByMinute,
  statusCounts,
  weatherHourAt,
  withPlanLabel,
  zoneRule,
  zoneRuleText,
} from '../data/selectors'
import type { OfflineResult } from '../offline/standIn'
import { PlanEditor } from '../components/PlanEditor'
import { VoicePanel } from '../voice'
import { NumberTicker } from '../components/NumberTicker'
import { OfflineBadge, OfflineBanner } from '../components/OfflineBadge'
import { ProvenanceLabels } from '../components/ProvenanceLabels'
import { WeatherComparison } from '../components/WeatherComparison'
import { IconCheck, IconClose, IconSpark } from '../components/Icons'
import { clockLabel, heatColor, type HeatScale } from '../lib/heat'
import { useHeatScale, useNearMargin } from '../lib/useHeatScale'
import { AI_NAME } from '../lib/brand'
import { ease, spring } from '../lib/motion'
import { CORE_DECIMALS, coreValue, fmtCore } from '../lib/format'
import './PlanView.css'

// Today's plan — the same plan the live roster and every athlete page use
// (the engine's demo plan, or voice / edited / optimized). Every number is the
// engine's /simulate (or /optimize) result for it. If the engine can't be
// reached, the stand-in's numbers are shown under an OFFLINE FALLBACK badge.
// Click a block for its details; Edit opens the timeline editor.

const CELL_MIN = 2
const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }
const INTENSITY: Record<string, string> = { rest: 'Rest', light: 'Light', moderate: 'Moderate', hard: 'Hard', max: 'Max' }
const PRIORITY: Record<number, string> = { 1: 'Must keep', 2: 'Normal', 3: 'Optional' }

interface Row {
  id: string
  name: string
  position: string
  /** p95 core estimate per minute (engine), or the stand-in curve offline. */
  series: number[]
  peak: number
  status: AthleteStatus
}

interface Forecasts {
  rows: Row[]
  limit: number
  weather: WeatherHour[]
  violations: { drill_id: string; text: string }[]
  offline: boolean
}

function fromSim(sim: SimulationResult, minutes: number, roster: ReturnType<typeof useRoster>): Forecasts {
  return {
    rows: sim.athletes.map((a) => ({
      id: a.id,
      name: roster.byId(a.id) ? roster.name(a.id) : (a.name ?? a.id),
      position: roster.byId(a.id)?.position ?? '',
      series: seriesByMinute(a.core_c_p95, sim.step_min, minutes),
      peak: a.peak_core_c_p95,
      status: a.status,
    })),
    limit: sim.limit_core_c,
    weather: sim.weather,
    violations: sim.fhsaa_violations.map((v) => ({ drill_id: v.drill_id, text: v.detail })),
    offline: false,
  }
}

function fromOffline(off: OfflineResult, roster: ReturnType<typeof useRoster>): Forecasts {
  return {
    rows: off.athletes.map((a) => ({
      id: a.id,
      name: roster.name(a.id),
      position: roster.byId(a.id)?.position ?? '',
      series: a.curve,
      peak: a.peak,
      status: a.status,
    })),
    limit: off.limitC,
    weather: off.weather,
    violations: [],
    offline: true,
  }
}

export function PlanView() {
  const p = usePlanState()
  const roster = useRoster()
  const meta = useEngineMeta()
  const zoneRules = meta.sources?.fhsaa_wbgt_zones?.zones
  const scale = useHeatScale()
  const margin = useNearMargin()
  const reduce = useReducedMotion()
  const [editing, setEditing] = useState(false)
  const [editFrom, setEditFrom] = useState<string | null>(null)
  const [openDrill, setOpenDrill] = useState<string | null>(null)
  // Which optimizer preset the coach asked for (for the spinner while /optimize runs).
  const [asked, setAsked] = useState<OptimizePreset>('max_load')
  const saveRequested = useRef(false)

  const drills = p.plan.drills
  const minutes = Math.round(planMinutes(p.plan))

  const now: Forecasts | null = useMemo(() => {
    if (p.sim) return fromSim(p.sim, minutes, roster)
    if (p.offline) return fromOffline(p.offline, roster)
    return null
  }, [p.sim, p.offline, minutes, roster])

  // "Before" numbers only exist when the engine optimized the plan.
  const before = p.sim && p.opt && p.source === 'optimized' ? p.opt.original : null
  const counts = p.sim ? statusCounts(p.sim.athletes) : null
  const beforeCounts = before ? statusCounts(before.athletes) : null

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
  const offline = !!now?.offline

  const optimizing = (preset: OptimizePreset) => p.phase === 'optimizing' && asked === preset
  const optimizedWith = (preset: OptimizePreset) => p.source === 'optimized' && (p.preset ?? 'max_load') === preset
  const optimize = (preset: OptimizePreset) => {
    setAsked(preset)
    void planStore.optimize(preset)
  }
  const fewestNote = p.opt && p.source === 'optimized' ? fewestChangesNote(p.opt.fewest_changes, p.opt.changes.length) : null

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
            Today · {clockLabel(startHour, 0)} – {clockLabel(startHour, minutes)} · <SourceLabel source={p.source} preset={p.preset} />
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
              className="btn btn--quiet btn--lg pressable"
              onClick={() => optimize('fewest_changes')}
              disabled={busy || p.source === 'optimized' || !p.sim}
              title={!p.sim ? 'Optimizing needs the engine' : 'The smallest edit that meets every rule (engine preset fewest_changes)'}
            >
              {optimizing('fewest_changes') ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Finding fewest changes…
                </>
              ) : optimizedWith('fewest_changes') ? (
                <>
                  <IconCheck width={18} height={18} /> Fewest changes
                </>
              ) : (
                'Fewest changes'
              )}
            </button>
            <button
              className="btn btn--ink btn--lg pressable"
              onClick={() => optimize('max_load')}
              disabled={busy || p.source === 'optimized' || !p.sim}
              title={!p.sim ? 'Optimizing needs the engine' : undefined}
            >
              {optimizing('max_load') ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Optimizing…
                </>
              ) : optimizedWith('max_load') ? (
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

      {offline && <OfflineBanner />}

      <ProvenanceLabels
        labels={withPlanLabel(
          p.sim
            ? [...(p.opt && p.source === 'optimized' ? (p.opt.labels ?? []) : []), ...p.sim.labels]
            : (p.offline?.labels ?? []),
          p.plan,
          meta.inputs,
        )}
        title={p.sim ? (p.source === 'optimized' ? 'Engine /optimize' : 'Engine /simulate') : 'Offline'}
      />

      {p.phase === 'error' && !editing && (
        <div className="plan__error" role="alert">
          {p.error}
          <button className="linkbtn" onClick={() => planStore.dismissError()}>
            Dismiss
          </button>
        </div>
      )}

      <div className="plan__summary">
        <Metric
          label="Forecast over the line (p95)"
          value={counts ? counts.over_limit : offline && now ? now.rows.filter((r) => r.status === 'over_limit').length : null}
          was={beforeCounts ? beforeCounts.over_limit : null}
          unit="athletes"
          note={counts ? `${counts.near_limit} near the line` : undefined}
          offline={offline}
        />
        <Metric
          label="Hottest forecast (p95)"
          value={nullableCore(p.sim ? hottestPeakP95(p.sim) : offline && now ? Math.max(...now.rows.map((r) => r.peak)) : null, now?.limit)}
          was={before ? nullableCore(hottestPeakP95(before), before.limit_core_c) : null}
          unit=" °C"
          // Two decimals so a peak just under the line (e.g. 38.98) never reads as the line itself (lib/format.ts).
          decimals={CORE_DECIMALS}
          offline={offline}
        />
        <Metric
          label="FHSAA issues"
          value={p.sim ? p.sim.fhsaa_violations.length : null}
          was={before ? before.fhsaa_violations.length : null}
          note={offline ? 'needs the engine' : undefined}
        />
        <Metric
          label="Training load kept"
          value={p.sim && p.opt && p.source === 'optimized' ? p.opt.load_kept_pct : null}
          was={null}
          unit="%"
          decimals={1}
          neutral
          note={p.sim && p.opt && p.source === 'optimized' ? 'of the original plan’s load' : 'shown after the engine optimizes'}
        />
      </div>

      {now && (
        <p className="faint plan__line-note">
          Planning line {now.limit.toFixed(1)} °C{margin != null ? `, near band ${margin.toFixed(1)} °C below it` : ''} —
          illustrative defaults an athletic trainer owns{offline ? ' (stand-in placeholders while offline)' : ' (engine GET /settings)'}. Counts use
          each athlete’s p95 estimate.
        </p>
      )}

      <VoicePanel />

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
              {now && !offline && (
                <div className="plan__rules">
                  <AnimatePresence mode="popLayout" initial={false}>
                    {now.violations.length === 0 ? (
                      <motion.span
                        key="ok"
                        className="rule rule--none"
                        initial={{ opacity: 0, transform: 'scale(0.95)' }}
                        animate={{ opacity: 1, transform: 'scale(1)' }}
                        exit={{ opacity: 0, transform: 'scale(0.95)' }}
                        transition={{ duration: 0.2, ease: ease.out }}
                      >
                        0 FHSAA issues found by the engine
                      </motion.span>
                    ) : (
                      now.violations.map((v, i) => (
                        <motion.span
                          key={`${i}-${v.text}`}
                          className="rule rule--bad rule--full"
                          initial={{ opacity: 0, transform: 'scale(0.95)' }}
                          animate={{ opacity: 1, transform: 'scale(1)' }}
                          exit={{ opacity: 0, transform: 'scale(0.95)' }}
                          transition={{ duration: 0.2, ease: ease.out }}
                        >
                          {hourLabel(v.text)}
                        </motion.span>
                      ))
                    )}
                  </AnimatePresence>
                  <span className="rule rule--cite faint">FHSAA issues: engine check · {FHSAA_CITATION}</span>
                </div>
              )}

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
                      {openDrill && now && (
                        <DrillPopover
                          key={openDrill}
                          drills={drills}
                          id={openDrill}
                          total={minutes}
                          startHour={startHour}
                          f={now}
                          scale={scale}
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
                    const h = now ? weatherHourAt(now.weather, p.plan.start, c * CELL_MIN) : null
                    const rule = zoneRule(zoneRules, h?.fhsaa_zone)
                    return (
                      <span
                        key={c}
                        style={{ background: zoneColor(h?.fhsaa_zone) }}
                        title={
                          h
                            ? `FHSAA zone ${h.fhsaa_zone} · WBGT ${h.wbgt_f.toFixed(1)} °F (forecast)${rule ? ` — ${zoneRuleText(rule)} (${FHSAA_CITATION})` : ''}`
                            : 'no forecast hour'
                        }
                      />
                    )
                  })}
                </div>
                <div />

                {!now && (
                  <>
                    <div />
                    <p className="faint plan__note">Modeling the plan on the engine…</p>
                    <div />
                  </>
                )}

                {now?.rows.map((r) => {
                  const f = r.series
                  return (
                    <div className="strip-row" key={r.id}>
                      <div className="plan__label">
                        <span className="num plan__num">{r.position}</span>
                        <span className="plan__name" title={r.name}>
                          {r.name}
                        </span>
                      </div>
                      <div className="strip">
                        {Array.from({ length: cols }, (_, c) => {
                          const v = f[Math.min(f.length - 1, c * CELL_MIN)]
                          return (
                            <span
                              key={c}
                              className={v >= now.limit ? 'is-over' : ''}
                              // Column-wise sweep, 6ms apart — the change reads as one wave through the session.
                              style={{ background: heatColor(v, scale), transitionDelay: reduce ? '0ms' : `${c * 6}ms` }}
                            />
                          )
                        })}
                      </div>
                      <div className={`plan__peak num ${r.status === 'over_limit' ? 'is-over' : ''}`}>
                        <NumberTicker value={coreValue(r.peak, now.limit)} decimals={CORE_DECIMALS} suffix="°" />
                        {offline && <OfflineBadge compact />}
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
                {offline
                  ? 'Heat strip: OFFLINE FALLBACK — in-browser stand-in, not the validated model.'
                  : 'Heat strip: the engine’s p95 core-temperature estimate per athlete, per minute — estimate, planning only. Click any block for details.'}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      <AnimatePresence>
        {p.opt && p.sim && !editing && p.source === 'optimized' && (
          <motion.section
            className="glass plan__changes"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)', filter: 'blur(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)', transition: { duration: 0.15 } }}
            transition={{ duration: 0.32, ease: ease.out }}
          >
            <div className="eyebrow">
              What the engine’s optimizer changed{p.preset === 'fewest_changes' ? ' · fewest changes' : ''}
            </div>
            {fewestNote && <p className="plan__top plan__fewest">{fewestNote}</p>}
            {p.opt.top_changes_text && <p className="plan__top">{p.opt.top_changes_text}</p>}
            {!p.opt.feasible && p.opt.infeasible_reasons?.length ? (
              <p className="plan__top">{p.opt.infeasible_reasons.join(' ')}</p>
            ) : null}
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

      {!editing && !offline && <WeatherComparison />}
    </div>
  )
}

/** A peak for the Metric tile, kept on its side of the line (lib/format.ts). */
function nullableCore(c: number | null, limit: number | null | undefined): number | null {
  return c == null ? null : coreValue(c, limit)
}

function SourceLabel({ source, preset }: { source: string; preset: OptimizePreset | null }) {
  const label: Record<string, string> = {
    fixture: 'Engine demo plan',
    voice: `From ${AI_NAME}`,
    optimized: preset === 'fewest_changes' ? 'Optimized by the engine · fewest changes' : 'Optimized by the engine',
    edited: 'Edited',
  }
  return <span className={`plan__src plan__src--${source}`}>{label[source]}</span>
}

/** Engine violation details start "Hour 2026-10-04T15:00:00-04:00: …"; show that as "3 PM hour: …" (text otherwise unchanged). */
function hourLabel(t: string) {
  const hour = /^Hour \S*T(\d\d):\S*\s+(.*)$/.exec(t)
  return (hour ? `${((Number(hour[1]) + 11) % 12) + 1} ${Number(hour[1]) >= 12 ? 'PM' : 'AM'} hour: ${hour[2]}` : t).trim()
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
  scale,
  onClose,
  onEdit,
}: {
  drills: ContractDrill[]
  id: string
  total: number
  startHour: number
  f: Forecasts
  scale: HeatScale | null
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

  const inBlock = f.rows
    .map((r) => {
      const seg = r.series.slice(Math.round(start), Math.round(end) + 1)
      return { r, peak: seg.length ? Math.max(...seg) : null }
    })
    .filter((x): x is { r: Row; peak: number } => x.peak != null)
    .sort((x, y) => y.peak - x.peak)
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
            Hottest p95 in this block · {overCount} at or over {f.limit.toFixed(1)} °C
            {f.offline && <OfflineBadge compact />}
          </div>
          <ul>
            {inBlock.slice(0, 3).map(({ r, peak }) => (
              <li key={r.id}>
                <span className="pop__dot" style={{ background: heatColor(peak, scale) }} />
                <span>{r.name}</span>
                <span className={`num ${peak >= f.limit ? 'is-over' : ''}`}>{fmtCore(peak, f.limit)}°</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <ul className="pop__issues">
          {issues.map((v, k) => (
            <li key={k}>{hourLabel(v.text)}</li>
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
  note,
  offline = false,
}: {
  label: string
  value: number | null
  was: number | null
  unit?: string
  decimals?: number
  neutral?: boolean
  note?: string
  offline?: boolean
}) {
  const better = value != null && was != null && value < was
  const word = unit === 'athletes'
  return (
    <div className={`glass metric ${!neutral && better ? 'is-better' : ''}`}>
      <div className="eyebrow">{label}</div>
      <div className="metric__value display-md">
        {value == null ? (
          <span className="faint">—</span>
        ) : (
          <>
            <NumberTicker value={value} decimals={decimals} suffix={word ? '' : unit} />
            {word && <span className="metric__unit">athletes</span>}
          </>
        )}
        {offline && value != null && <OfflineBadge compact />}
      </div>
      <div className="metric__was faint num">
        {was != null ? `was ${was.toFixed(decimals)}${word ? '' : unit}` : ''}
        {was != null && note ? ' · ' : ''}
        {note ?? (was == null ? 'current plan' : '')}
      </div>
    </div>
  )
}
