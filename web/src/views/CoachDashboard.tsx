import { useMemo } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { RosterAthlete } from '../data/engineApi'
import { replayLabel, useSession, type SessionState } from '../data/engine'
import { useEngineMeta } from '../data/engineMeta'
import { useRoster } from '../data/roster'
import { ESTIMATE_LABEL, zoneColor } from '../data/constants'
import { SCHOOL } from '../data/fixtures'
import { drillAtMinute, FHSAA_CITATION, noHrLabel, statusCounts, zoneRule, zoneRuleText, type AthleteLive } from '../data/selectors'
import { NumberTicker } from '../components/NumberTicker'
import { StatusPill } from '../components/StatusPill'
import { TempChart } from '../components/TempChart'
import { OfflineBadge, OfflineBanner } from '../components/OfflineBadge'
import { IconArrow, IconDrop, IconHeart, IconResponse } from '../components/Icons'
import { clockLabel } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import './CoachDashboard.css'

// Live roster. Every number is the engine's, read at the demo playback minute
// (data/engine.ts → selectors.ts). Status is the engine's (below / near / over
// the AT-owned planning line, by p95). The red alert row and card appear only
// when the engine's HR-calibration gates raise a flag.

const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }

/** Sort bucket: engine flag first, then over / near / below the line. Re-ranks only when a bucket changes. */
function bucket(a: AthleteLive) {
  if (a.flag) return 0
  return a.status === 'over_limit' ? 1 : a.status === 'near_limit' ? 2 : 3
}

interface Props {
  acked: Set<string>
  onAck: (id: string) => void
  onOpenAthlete: (id: string) => void
  onCollapse: (id: string) => void
}

export function CoachDashboard({ acked, onAck, onOpenAthlete, onCollapse }: Props) {
  const s = useSession()
  const roster = useRoster()
  const reduce = useReducedMotion()
  const offline = s.source === 'offline'

  const live = roster.athletes.filter((a) => s.athletes[a.id])
  // Re-rank only by bucket, never by the live number — rows that shuffle every
  // second would make the roster unreadable.
  const bucketKey = live.map((a) => `${a.id}:${bucket(s.athletes[a.id])}`).join()
  const order = useMemo(
    () => [...live].sort((a, b) => bucket(s.athletes[a.id]) - bucket(s.athletes[b.id])),
    [bucketKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const alerts = order.filter((a) => s.athletes[a.id].flag && !acked.has(a.id))
  const lead = alerts[0]
  const counts = statusCounts(live.map((a) => s.athletes[a.id]))

  return (
    <div className="coach">
      {offline && <OfflineBanner />}
      <LayoutGroup>
        <div className={`coach__top ${lead ? 'has-alert' : ''}`}>
          <AnimatePresence mode="popLayout">
            {lead && (
              <AlertCard
                key={`alert-${lead.id}`}
                athlete={lead}
                name={roster.name(lead.id)}
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
            {lead && <GuidanceCard key="guide" onCollapse={() => onCollapse(lead.id)} />}
          </AnimatePresence>
        </div>
      </LayoutGroup>

      <div className="roster" role="table" aria-label="Roster heat status">
        <div className="roster__head" role="row">
          <span role="columnheader">Athlete</span>
          <span role="columnheader">Acclimatization</span>
          <span role="columnheader">Heart rate</span>
          <span role="columnheader">Est. core (p50)</span>
          <span role="columnheader">Session · forecast</span>
          <span role="columnheader" className="roster__head-status">
            Status (p95)
          </span>
        </div>
        {s.source === 'loading' && <p className="faint coach__foot">Loading the engine’s forecast…</p>}
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
              name={roster.name(a.id)}
              live={s.athletes[a.id]}
              s={s}
              index={i}
              onOpen={() => onOpenAthlete(a.id)}
            />
          </motion.div>
        ))}
      </div>

      <p className="coach__foot faint">
        {SCHOOL} · Core temperatures are an {ESTIMATE_LABEL} — never a diagnosis. Athletes without HR show the plan
        forecast only. The planning line is an illustrative default an athletic trainer owns.
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
  counts: Record<'below_limit' | 'near_limit' | 'over_limit', number>
}) {
  const drills = s.plan?.drills ?? []
  const at = drillAtMinute(drills, s.minute)
  const drill = at?.drill
  const total = Math.max(1, s.totalMinutes)
  const progress = s.minute / total
  const starts = drills.map((_, i) => drills.slice(0, i).reduce((sum, d) => sum + d.duration_min, 0))
  const w = s.weather
  const meta = useEngineMeta()
  const rule = zoneRule(meta.sources?.fhsaa_wbgt_zones?.zones, w?.fhsaa_zone)

  return (
    <motion.section layout transition={spring.move} className="session glass" aria-label="Practice session">
      <motion.div layout="position" transition={spring.move} className="session__inner">
        <div className="session__now">
          <div className="session__eyebrow">
            <span className="eyebrow">Demo clock · {clockLabel(s.startHour, s.minute)}</span>
            <span className="session__src">demo playback — not live</span>
            {replayLabel(s.replay) && <span className="session__src session__src--replay">{replayLabel(s.replay)}</span>}
            {s.replay.status === 'loading' && <span className="session__src">loading HR replay…</span>}
            {s.replay.status === 'error' && (
              <span className="session__src" title={s.replay.error ?? undefined}>
                HR replay unavailable — plan forecast only
              </span>
            )}
          </div>
          <div className="session__drill">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.h2
                key={drill?.id ?? 'none'}
                className="display-md"
                initial={{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(30%)' }}
                animate={{ opacity: 1, filter: 'blur(0px)', transform: 'translateY(0%)' }}
                exit={{ opacity: 0, filter: 'blur(4px)', transform: 'translateY(-30%)' }}
                transition={{ duration: 0.28, ease: ease.out }}
              >
                {drill ? drill.name.charAt(0).toUpperCase() + drill.name.slice(1) : '—'}
              </motion.h2>
            </AnimatePresence>
          </div>
          {drill && (
            <div className="session__meta muted">
              <span className="num">{Math.ceil(s.drillMinuteLeft)} min left</span>
              <span aria-hidden="true">·</span>
              <span>{GEAR[drill.gear]}</span>
            </div>
          )}
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
            <Stat label="FHSAA (forecast)">
              {w ? (
                <span
                  className="session__zone"
                  title={rule ? `Zone ${w.fhsaa_zone}: ${zoneRuleText(rule)} — ${FHSAA_CITATION}` : undefined}
                >
                  <span className="session__zone-dot" style={{ background: zoneColor(w.fhsaa_zone) }} />
                  <span className="num">
                    FHSAA zone {w.fhsaa_zone} · WBGT {w.wbgt_f.toFixed(1)} °F (forecast)
                  </span>
                  {s.source === 'offline' && <OfflineBadge compact />}
                </span>
              ) : (
                '—'
              )}
            </Stat>
            <Stat label="Roster · below / near / over">
              <span className="session__counts num">
                <span style={{ color: 'var(--steady)' }} title="Below line">
                  {counts.below_limit}
                </span>
                <span style={{ color: 'var(--watch)' }} title="Near line">
                  {counts.near_limit}
                </span>
                <span style={{ color: 'var(--alert)' }} title="Over line">
                  {counts.over_limit}
                </span>
              </span>
            </Stat>
          </div>
        )}
      </motion.div>

      <div className="session__timeline" aria-hidden="true">
        {drills.map((d, i) => {
          const left = (starts[i] / total) * 100
          const kind = d.is_break ? 'break' : d.intensity === 'max' ? 'conditioning' : 'work'
          return (
            <span
              key={d.id}
              className={`session__seg session__seg--${kind} ${d.id === drill?.id ? 'is-now' : ''}`}
              style={{ left: `${left}%`, width: `calc(${(d.duration_min / total) * 100}% - 3px)` }}
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
  name,
  live,
  more,
  onAck,
  onOpen,
  onCollapse,
}: {
  athlete: RosterAthlete
  name: string
  live: AthleteLive
  more: number
  onAck: () => void
  onOpen: () => void
  onCollapse: () => void
}) {
  const reduce = useReducedMotion()
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
        <span className="eyebrow alertcard__eyebrow">Engine flag · {live.gates?.message ?? 'estimate over the line'}</span>
        {more > 0 && <span className="alertcard__more num">+{more} more</span>}
      </div>
      <button className="alertcard__who pressable" onClick={onOpen}>
        <span className="display-sm">{name}</span>
        <span className="faint">
          {athlete.position ?? '—'} · Day {athlete.acclimatization_day}
        </span>
      </button>
      <div className="alertcard__temp display-lg">
        <NumberTicker value={live.coreC} decimals={1} suffix="°C" />
      </div>
      <div className="alertcard__meta muted">
        {ESTIMATE_LABEL} · peak p95 <span className="num">{live.peakP95C.toFixed(1)}°</span>
        {live.firstCrossMin != null && (
          <>
            {' '}· crosses at <span className="num">{Math.round(live.firstCrossMin)}′</span>
          </>
        )}
      </div>
      <div className="alertcard__actions">
        <button className="btn btn--alert pressable" onClick={onCollapse}>
          <IconResponse width={18} height={18} /> Collapse response
        </button>
        <button className="btn btn--quiet pressable" onClick={onAck}>
          Acknowledge
        </button>
      </div>
    </motion.section>
  )
}

function GuidanceCard({ onCollapse }: { onCollapse: () => void }) {
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
      <div className="eyebrow">What this means</div>
      <p className="guide__text">
        Estimate over the AT-owned planning line — review with your athletic trainer. If an athlete shows signs of heat
        illness, follow your school’s emergency action plan.
      </p>
      <div className="guide__foot">
        <button className="linkbtn" onClick={onCollapse}>
          Open Collapse mode
        </button>
      </div>
    </motion.section>
  )
}

function RosterRow({
  athlete,
  name,
  live,
  s,
  index,
  onOpen,
}: {
  athlete: RosterAthlete
  name: string
  live: AthleteLive
  s: SessionState
  index: number
  onOpen: () => void
}) {
  const meta = useEngineMeta()
  const acclimDays = meta.sources?.nata_ehs?.acclimatization_days
  const ticks = acclimDays?.length ? Math.max(...acclimDays) : 0
  const offline = live.basis === 'offline'
  const tone = live.flag ? 'alert' : live.status === 'below_limit' ? 'steady' : 'watch'
  return (
    <button
      className={`row row--${tone}`}
      role="row"
      onClick={onOpen}
      style={{ ['--i' as string]: index }}
      aria-label={`${name}, estimated core ${live.coreC.toFixed(1)} degrees, ${live.status.replace('_', ' ')}`}
    >
      <span className="row__who" role="cell">
        <span className="row__num num">{athlete.position ?? '—'}</span>
        <span>
          <span className="row__name">{name}</span>
          <span className="row__sub">
            {athlete.mass_kg} kg · {athlete.height_m} m
          </span>
        </span>
      </span>

      <span className="row__acclim" role="cell">
        <span className="row__acclim-label num">Day {athlete.acclimatization_day}</span>
        {ticks > 0 && (
          <span className="row__ticks" aria-hidden="true" title={`NATA: acclimatization over ${acclimDays?.join('–')} days`}>
            {Array.from({ length: ticks }, (_, i) => (
              <span key={i} className={i < athlete.acclimatization_day ? 'is-on' : ''} />
            ))}
          </span>
        )}
      </span>

      <span className="row__hr" role="cell">
        {live.hr != null ? (
          <span className="row__hr-stack" title={noHrLabel(live)}>
            <span className="row__hr-line">
              <IconHeart width={15} height={15} className="row__heart" />
              <NumberTicker value={live.hr} />
              <span className="row__unit">bpm</span>
            </span>
            <span className="row__nostrap">HR replay</span>
          </span>
        ) : (
          <span className="row__nostrap">{noHrLabel(live)}</span>
        )}
      </span>

      <span className="row__core" role="cell">
        <span className="row__core-val display-sm">
          <NumberTicker value={live.coreC} decimals={1} suffix="°" />
          {offline && <OfflineBadge compact />}
        </span>
        <span className="row__peak num">
          peak p95 {live.peakP95C.toFixed(1)}°{live.peakMin != null ? ` @ ${Math.round(live.peakMin)}′` : ''}
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
          limit={s.limitC}
        />
      </span>

      <span className="row__status" role="cell">
        <StatusPill status={live.status} size="sm" />
        <IconArrow width={16} height={16} className="row__go" />
      </span>
    </button>
  )
}
