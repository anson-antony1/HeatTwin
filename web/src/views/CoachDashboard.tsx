import { useMemo } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { Athlete, AthleteLive, SessionState } from '../data/types'
import { useSession, usePlan } from '../data/engine'
import { usePlanState } from '../data/planStore'
import { ROSTER, SCHOOL } from '../data/fixtures'
import { THRESHOLDS, ZONE_COLOR } from '../data/constants'
import { drillAt } from '../data/model'
import { NumberTicker } from '../components/NumberTicker'
import { StatusPill } from '../components/StatusPill'
import { TempChart } from '../components/TempChart'
import { IconArrow, IconDrop, IconHeart, IconResponse } from '../components/Icons'
import { clockLabel, gearLabel } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import './CoachDashboard.css'

const RANK = { alert: 0, watch: 1, steady: 2 } as const

interface Props {
  acked: Set<string>
  onAck: (id: string) => void
  onOpenAthlete: (id: string) => void
  onCollapse: (id: string) => void
}

export function CoachDashboard({ acked, onAck, onOpenAthlete, onCollapse }: Props) {
  const s = useSession()
  const reduce = useReducedMotion()

  // Re-rank only by status bucket, never by the live number — rows that
  // shuffle every second would make the roster unreadable. Status changes are
  // rare, so when a row does move it's news, and the spring shows where it went.
  const statusKey = ROSTER.map((a) => s.athletes[a.id].status).join()
  const order = useMemo(
    () => [...ROSTER].sort((a, b) => RANK[s.athletes[a.id].status] - RANK[s.athletes[b.id].status]),
    // Only re-rank when a status flips.
    [statusKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const alerts = order.filter((a) => s.athletes[a.id].status === 'alert' && !acked.has(a.id))
  const lead = alerts[0]

  const counts = ROSTER.reduce(
    (c, a) => ({ ...c, [s.athletes[a.id].status]: c[s.athletes[a.id].status] + 1 }),
    { steady: 0, watch: 0, alert: 0 },
  )

  return (
    <div className="coach">
      <LayoutGroup>
        <div className={`coach__top ${lead ? 'has-alert' : ''}`}>
          <AnimatePresence mode="popLayout">
            {lead && (
              <AlertCard
                key={`alert-${lead.id}`}
                athlete={lead}
                live={s.athletes[lead.id]}
                more={alerts.length - 1}
                onAck={() => onAck(lead.id)}
                onOpen={() => onOpenAthlete(lead.id)}
                onCollapse={() => onCollapse(lead.id)}
              />
            )}
          </AnimatePresence>

          <SessionHeader s={s} compact={!!lead} counts={counts} />

          <AnimatePresence mode="popLayout">
            {lead && <GuidanceCard key="guide" />}
          </AnimatePresence>
        </div>
      </LayoutGroup>

      <div className="roster" role="table" aria-label="Roster heat status">
        <div className="roster__head" role="row">
          <span role="columnheader">Athlete</span>
          <span role="columnheader">Acclimatization</span>
          <span role="columnheader">Heart rate</span>
          <span role="columnheader">Est. core</span>
          <span role="columnheader">Session · forecast</span>
          <span role="columnheader" className="roster__head-status">
            Status
          </span>
        </div>
        {order.map((a, i) => (
          <motion.div
            key={a.id}
            layout={reduce ? false : 'position'}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(8px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            // Stagger the first paint only — 35ms apart, never blocking input.
            transition={{ layout: spring.move, default: { duration: 0.3, ease: ease.out, delay: i * 0.035 } }}
          >
            <RosterRow
              athlete={a}
              live={s.athletes[a.id]}
              s={s}
              index={i}
              onOpen={() => onOpenAthlete(a.id)}
            />
          </motion.div>
        ))}
      </div>

      <p className="coach__foot faint">
        {SCHOOL} · Estimates are for planning and early warning only — never a diagnosis. Rows without a strap show
        the plan forecast alone.
      </p>
    </div>
  )
}

function SessionHeader({
  s,
  compact,
  counts,
}: {
  s: SessionState
  compact: boolean
  counts: Record<'steady' | 'watch' | 'alert', number>
}) {
  const plan = usePlan()
  const planState = usePlanState()
  const { drill } = drillAt(plan, s.minute)
  const progress = s.minute / s.totalMinutes
  const starts = plan.map((_, i) => plan.slice(0, i).reduce((sum, d) => sum + d.minutes, 0))

  return (
    <motion.section layout transition={spring.move} className="session glass" aria-label="Practice session">
      <motion.div layout="position" transition={spring.move} className="session__inner">
        <div className="session__now">
          <div className="session__eyebrow">
            <span className="eyebrow">Now · {clockLabel(s.startHour, s.minute)}</span>
            {planState.source !== 'fixture' && (
              <span className={`session__src session__src--${planState.source}`}>
                {planState.source === 'voice' ? 'Voice plan · engine forecast' : 'Optimized · engine forecast'}
              </span>
            )}
          </div>
          <div className="session__drill">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.h2
                key={drill.id}
                className="display-md"
                initial={{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(30%)' }}
                animate={{ opacity: 1, filter: 'blur(0px)', transform: 'translateY(0%)' }}
                exit={{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(-30%)' }}
                transition={{ duration: 0.28, ease: ease.out }}
              >
                {drill.name}
              </motion.h2>
            </AnimatePresence>
          </div>
          <div className="session__meta muted">
            <span className="num">{Math.ceil(s.drillMinuteLeft)} min left</span>
            <span aria-hidden="true">·</span>
            <span>{gearLabel(drill.gear)}</span>
          </div>
        </div>

        {!compact && (
          <div className="session__stats">
            <Stat label="Next break">
              {s.nextBreakIn == null ? (
                '—'
              ) : s.nextBreakIn === 0 ? (
                <span className="session__onbreak">
                  <IconDrop width={18} height={18} /> Now
                </span>
              ) : (
                <NumberTicker value={Math.ceil(s.nextBreakIn)} suffix="min" />
              )}
            </Stat>
            <Stat label="FHSAA zone">
              <span className="session__zone">
                <span className="session__zone-dot" style={{ background: ZONE_COLOR[s.zone.id] }} />
                {s.zone.id[0].toUpperCase() + s.zone.id.slice(1)}
              </span>
            </Stat>
            <Stat label="Roster">
              <span className="session__counts num">
                <span style={{ color: 'var(--steady)' }}>{counts.steady}</span>
                <span style={{ color: 'var(--watch)' }}>{counts.watch}</span>
                <span style={{ color: 'var(--alert)' }}>{counts.alert}</span>
              </span>
            </Stat>
          </div>
        )}
      </motion.div>

      <div className="session__timeline" aria-hidden="true">
        {plan.map((d, i) => {
          const left = (starts[i] / s.totalMinutes) * 100
          return (
            <span
              key={d.id}
              className={`session__seg session__seg--${d.kind} ${d.id === drill.id ? 'is-now' : ''}`}
              style={{ left: `${left}%`, width: `calc(${(d.minutes / s.totalMinutes) * 100}% - 3px)` }}
            />
          )
        })}
        <span className="session__playhead" style={{ transform: `translateX(${progress * 100}cqw)` }} />
      </div>
    </motion.section>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="eyebrow">{label}</div>
      <div className="stat__value display-sm">{children}</div>
    </div>
  )
}

function AlertCard({
  athlete,
  live,
  more,
  onAck,
  onOpen,
  onCollapse,
}: {
  athlete: Athlete
  live: AthleteLive
  more: number
  onAck: () => void
  onOpen: () => void
  onCollapse: () => void
}) {
  const reduce = useReducedMotion()
  const h = live.history
  const rate = h.length > 5 ? (h[h.length - 1] - h[h.length - 6]) / 5 : 0
  return (
    <motion.section
      layout
      className="alertcard glass"
      role="alert"
      // Materialize: blur + scale + opacity together, so the glass reads as
      // arriving rather than just fading in.
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.96)', filter: 'blur(8px)' }}
      animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.97)', filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ duration: 0.36, ease: ease.out, layout: spring.move }}
    >
      <div className="alertcard__top">
        <span className="alertcard__beacon" aria-hidden="true" />
        <span className="eyebrow alertcard__eyebrow">Over the alert line</span>
        {more > 0 && <span className="alertcard__more num">+{more} more</span>}
      </div>
      <button className="alertcard__who pressable" onClick={onOpen}>
        <span className="display-sm">{athlete.name}</span>
        <span className="faint">
          #{athlete.number} · {athlete.position} · Day {athlete.acclimDay}
        </span>
      </button>
      <div className="alertcard__temp display-lg">
        <NumberTicker value={live.coreC} decimals={1} suffix="°C" />
      </div>
      <div className="alertcard__meta muted">
        Est. over {THRESHOLDS.alertC.toFixed(1)}° for{' '}
        <span className="num">{live.minutesOverLine}</span> min
        {rate > 0.005 && (
          <>
            {' '}· rising <span className="num">{rate.toFixed(2)}</span>°/min
          </>
        )}
      </div>
      <div className="alertcard__actions">
        <button className="btn btn--alert pressable" onClick={onCollapse}>
          <IconResponse width={18} height={18} /> Collapse response
        </button>
        <button className="btn btn--quiet pressable" onClick={onAck}>
          Pulled & checked
        </button>
      </div>
    </motion.section>
  )
}

function GuidanceCard() {
  const reduce = useReducedMotion()
  return (
    <motion.section
      layout
      className="guide glass"
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateX(24px)', filter: 'blur(6px)' }}
      animate={{ opacity: 1, transform: 'translateX(0px)', filter: 'blur(0px)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateX(24px)', filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ duration: 0.36, ease: ease.out, delay: reduce ? 0 : 0.06, layout: spring.move }}
    >
      <div className="eyebrow">Do this now</div>
      <ol className="guide__steps">
        <li>Pull from activity, into shade</li>
        <li>Remove helmet and pads</li>
        <li>Check: confused, stumbling, collapsed?</li>
      </ol>
      <div className="guide__foot">
        Any “yes” → <strong>Collapse response</strong>. Cool first, transport second.
      </div>
    </motion.section>
  )
}

function RosterRow({
  athlete,
  live,
  s,
  index,
  onOpen,
}: {
  athlete: Athlete
  live: AthleteLive
  s: SessionState
  index: number
  onOpen: () => void
}) {
  return (
    <button
      className={`row row--${live.status}`}
      role="row"
      onClick={onOpen}
      style={{ ['--i' as string]: index }}
      aria-label={`${athlete.name}, estimated core ${live.coreC.toFixed(1)} degrees, ${live.status}`}
    >
      <span className="row__who" role="cell">
        <span className="row__num num">{athlete.number}</span>
        <span>
          <span className="row__name">{athlete.name}</span>
          <span className="row__sub">
            {athlete.position} · {athlete.massKg} kg
          </span>
        </span>
      </span>

      <span className="row__acclim" role="cell">
        <span className="row__acclim-label num">Day {athlete.acclimDay}</span>
        <span className="row__ticks" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className={i < athlete.acclimDay ? 'is-on' : ''} />
          ))}
        </span>
      </span>

      <span className="row__hr" role="cell">
        {live.hr != null ? (
          <>
            <IconHeart width={15} height={15} className="row__heart" />
            <NumberTicker value={live.hr} />
            <span className="row__unit">bpm</span>
          </>
        ) : (
          <span className="row__nostrap">No strap · model</span>
        )}
      </span>

      <span className="row__core" role="cell">
        <span className="row__core-val display-sm">
          <NumberTicker value={live.coreC} decimals={1} suffix="°" />
        </span>
        <span className="row__peak num">
          peak {live.predictedPeakC.toFixed(1)}° @ {live.predictedPeakMin}′
        </span>
      </span>

      <span className="row__spark" role="cell">
        <TempChart
          compact
          history={live.history}
          forecast={live.forecast}
          band={live.band}
          total={s.totalMinutes}
          now={s.minute}
          live={live.coreC}
        />
      </span>

      <span className="row__status" role="cell">
        <StatusPill status={live.status} size="sm" />
        <IconArrow width={16} height={16} className="row__go" />
      </span>
    </button>
  )
}
