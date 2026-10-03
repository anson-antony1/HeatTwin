import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
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
          <div className="eyebrow">Estimated core</div>
          <div className="display-xl vitals__temp" style={{ color: heatColor(live.coreC) }}>
            <NumberTicker value={live.coreC} decimals={1} suffix="°C" />
          </div>
          <div className="muted num" style={{ fontSize: 14 }}>
            {cToF(live.coreC).toFixed(1)} °F · ±{nextBand.toFixed(2)}° (p95)
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
        <BodyFigure coreC={live.coreC} hr={live.hr} />
        <div className="twin__callout twin__callout--core">
          <span className="twin__callout-dot" style={{ background: heatColor(live.coreC) }} />
          Core
        </div>
        {live.hr != null && (
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
          <ul className="legend">
            <li><span className="legend__swatch legend__swatch--est" />Estimate</li>
            <li><span className="legend__swatch legend__swatch--fc" />Forecast</li>
            <li><span className="legend__swatch legend__swatch--band" />p95</li>
          </ul>
        </div>
        <div className="forecast__chart">
          <TempChart
            reveal
            history={live.history}
            forecast={live.forecast}
            band={live.band}
            total={s.totalMinutes}
            now={s.minute}
            live={live.coreC}
            drills={plan}
          />
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
        ? 'Optimized by the twin'
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
