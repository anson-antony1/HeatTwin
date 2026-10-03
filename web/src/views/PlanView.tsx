import { useMemo, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { Drill } from '../data/types'
import { engine } from '../data/engine'
import { FORECAST, PLAN, PRACTICE_START_HOUR, ROSTER } from '../data/fixtures'
import { THRESHOLDS, zoneFor, ZONE_COLOR } from '../data/constants'
import { peakOf, totalMinutes, wbgtAt } from '../data/model'
import { checkRules, forecastRoster, optimize, type PlanResult } from '../data/optimizer'
import { NumberTicker } from '../components/NumberTicker'
import { IconCheck, IconSpark } from '../components/Icons'
import { clockLabel, gearLabel, heatColor } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import './PlanView.css'

const CELL_MIN = 2

export function PlanView() {
  const reduce = useReducedMotion()
  const [result, setResult] = useState<PlanResult | null>(null)
  const [applied, setApplied] = useState(false)

  const original = useMemo(() => forecastRoster(ROSTER, PLAN, FORECAST, PRACTICE_START_HOUR), [])
  const optimized = useMemo(
    () => (result ? forecastRoster(ROSTER, result.plan, FORECAST, PRACTICE_START_HOUR, result.sitOuts) : null),
    [result],
  )

  const plan = result?.plan ?? PLAN
  const series = optimized ?? original
  const total = totalMinutes(plan)
  const violations = checkRules(plan, FORECAST, PRACTICE_START_HOUR)
  const beforeViolations = checkRules(PLAN, FORECAST, PRACTICE_START_HOUR)

  const over = (f: Record<string, number[]>) => ROSTER.filter((a) => peakOf(f[a.id]).value >= THRESHOLDS.alertC).length
  const maxPeak = (f: Record<string, number[]>) => Math.max(...ROSTER.map((a) => peakOf(f[a.id]).value))

  const cols = Math.ceil(total / CELL_MIN)

  const runOptimize = () => {
    setApplied(false)
    setResult(result ? null : optimize(ROSTER, PLAN, FORECAST, PRACTICE_START_HOUR))
  }

  const apply = () => {
    if (!result) return
    engine.setPlan(result.plan)
    engine.play()
    setApplied(true)
  }

  return (
    <div className="plan">
      <header className="plan__head">
        <div>
          <div className="eyebrow">Today · {clockLabel(PRACTICE_START_HOUR, 0)} – {clockLabel(PRACTICE_START_HOUR, total)}</div>
          <h1 className="display-lg">Practice plan</h1>
        </div>
        <div className="plan__actions">
          {result && (
            <button className={`btn btn--quiet pressable ${applied ? 'is-done' : ''}`} onClick={apply} disabled={applied}>
              {applied ? (
                <>
                  <IconCheck width={16} height={16} /> Running this plan
                </>
              ) : (
                'Use for today'
              )}
            </button>
          )}
          <button className="btn btn--ink btn--lg pressable" onClick={runOptimize}>
            <IconSpark width={18} height={18} />
            {result ? 'Show original' : 'Optimize plan'}
          </button>
        </div>
      </header>

      <div className="plan__summary">
        <Metric label="Forecast over the line" before={over(original)} after={optimized ? over(optimized) : null} unit=" athletes" />
        <Metric label="Hottest forecast" before={maxPeak(original)} after={optimized ? maxPeak(optimized) : null} unit="°" decimals={1} />
        <Metric label="FHSAA issues" before={beforeViolations.length} after={result ? violations.length : null} />
        <Metric label="Training load kept" before={100} after={result ? Math.round(result.loadKept * 100) : null} unit="%" neutral />
      </div>

      <section className="glass plan__board">
        <div className="plan__rules">
          <AnimatePresence mode="popLayout" initial={false}>
            {violations.length === 0 ? (
              <motion.span
                key="ok"
                className="rule rule--ok"
                initial={{ opacity: 0, transform: 'scale(0.95)' }}
                animate={{ opacity: 1, transform: 'scale(1)' }}
                exit={{ opacity: 0, transform: 'scale(0.95)' }}
                transition={{ duration: 0.2, ease: ease.out }}
              >
                <IconCheck width={14} height={14} /> Meets FHSAA {zoneFor(peakWbgt(total)).id} zone rules
              </motion.span>
            ) : (
              violations.map((v) => (
                <motion.span
                  key={v.text}
                  className="rule rule--bad"
                  initial={{ opacity: 0, transform: 'scale(0.95)' }}
                  animate={{ opacity: 1, transform: 'scale(1)' }}
                  exit={{ opacity: 0, transform: 'scale(0.95)' }}
                  transition={{ duration: 0.2, ease: ease.out }}
                >
                  {v.text}
                </motion.span>
              ))
            )}
          </AnimatePresence>
        </div>

        <div className="plan__grid" style={{ ['--cols' as string]: cols }}>
          {/* Drill timeline */}
          <div className="plan__label plan__label--head">Drill</div>
          <LayoutGroup>
            <div className="timeline">
              <AnimatePresence initial={false}>
                {plan.map((d) => (
                  <DrillBlock key={d.id} d={d} total={total} reduce={!!reduce} />
                ))}
              </AnimatePresence>
            </div>
          </LayoutGroup>
          <div />

          {/* WBGT strip */}
          <div className="plan__label">WBGT</div>
          <div className="wbgt">
            {Array.from({ length: cols }, (_, c) => {
              const z = zoneFor(wbgtAt(FORECAST, PRACTICE_START_HOUR + (c * CELL_MIN) / 60))
              return <span key={c} style={{ background: ZONE_COLOR[z.id] }} />
            })}
          </div>
          <div />

          {/* Per-athlete heat strip */}
          {ROSTER.map((a) => {
            const f = series[a.id]
            const peak = peakOf(f).value
            const sat = result?.sitOuts[a.id]?.length
            return (
              <div className="strip-row" key={a.id}>
                <div className="plan__label">
                  <span className="num plan__num">{a.number}</span>
                  <span className="plan__name">{a.name}</span>
                  {sat ? <span className="plan__sat">rotates out</span> : null}
                </div>
                <div className="strip">
                  {Array.from({ length: cols }, (_, c) => {
                    const v = f[Math.min(f.length - 1, c * CELL_MIN)]
                    return (
                      <span
                        key={c}
                        className={v >= THRESHOLDS.alertC ? 'is-over' : ''}
                        // Column-wise sweep, 6ms apart — the change reads as
                        // one wave moving through the session.
                        style={{ background: heatColor(v), transitionDelay: reduce ? '0ms' : `${c * 6}ms` }}
                      />
                    )
                  })}
                </div>
                <div className={`plan__peak num ${peak >= THRESHOLDS.alertC ? 'is-over' : ''}`}>
                  <NumberTicker value={peak} decimals={1} suffix="°" />
                </div>
              </div>
            )
          })}

          <div />
          <div className="plan__axis num">
            {Array.from({ length: Math.floor(total / 15) + 1 }, (_, i) => (
              <span key={i} style={{ left: `${((i * 15) / total) * 100}%` }}>
                {clockLabel(PRACTICE_START_HOUR, i * 15).replace(' PM', '')}
              </span>
            ))}
          </div>
          <div />
        </div>
      </section>

      <AnimatePresence>
        {result && (
          <motion.section
            className="glass plan__changes"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)', filter: 'blur(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)', filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)', transition: { duration: 0.15 } }}
            transition={{ duration: 0.32, ease: ease.out }}
          >
            <div className="eyebrow">What changed</div>
            <ul>
              {result.changes.map((c, i) => (
                <motion.li
                  key={c.text}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px)' }}
                  transition={{ duration: 0.28, ease: ease.out, delay: 0.12 + i * 0.05 }}
                >
                  <span className={`change change--${c.kind}`}>{c.kind.replace('-', ' ')}</span>
                  {c.text}
                </motion.li>
              ))}
            </ul>
            <p className="faint plan__note">
              Forecasts use each athlete’s heat factor from previous sessions. Live heart rate keeps refining it during
              practice.
            </p>
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  )
}

function peakWbgt(total: number) {
  let p = 0
  for (let m = 0; m <= total; m += 5) p = Math.max(p, wbgtAt(FORECAST, PRACTICE_START_HOUR + m / 60))
  return p
}

function DrillBlock({ d, total, reduce }: { d: Drill; total: number; reduce: boolean }) {
  return (
    <motion.div
      layout={!reduce}
      className={`block block--${d.kind}`}
      style={{ flexGrow: d.minutes, flexBasis: 0 }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.9)' }}
      animate={{ opacity: 1, transform: 'scale(1)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.9)', transition: { duration: 0.15 } }}
      transition={{ layout: spring.move, duration: 0.24, ease: ease.out }}
      title={`${d.name} · ${d.minutes} min · ${d.gear}`}
    >
      {d.minutes / total > 0.06 && (
        <motion.span layout="position" className="block__text">
          <span className="block__name">{d.name}</span>
          <span className="block__min num">
            {d.minutes}′ · {gearLabel(d.gear).toLowerCase()}
          </span>
        </motion.span>
      )}
    </motion.div>
  )
}

function Metric({
  label,
  before,
  after,
  unit = '',
  decimals = 0,
  neutral = false,
}: {
  label: string
  before: number
  after: number | null
  unit?: string
  decimals?: number
  neutral?: boolean
}) {
  const value = after ?? before
  const better = after != null && after < before
  return (
    <div className={`glass metric ${after != null && !neutral ? (better ? 'is-better' : '') : ''}`}>
      <div className="eyebrow">{label}</div>
      <div className="metric__value display-md">
        <NumberTicker value={value} decimals={decimals} suffix={unit.trim() === 'athletes' ? '' : unit} />
        {unit.trim() === 'athletes' && <span className="metric__unit">athletes</span>}
      </div>
      <div className="metric__was faint num">
        {after != null ? `was ${before.toFixed(decimals)}${unit.trim() === 'athletes' ? '' : unit}` : 'original plan'}
      </div>
    </div>
  )
}
