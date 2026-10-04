import { useMemo, useState } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import type { AthleteLive } from '../data/types'
import type { LiveSuggestion, RosterAthlete } from '../data/engineApi'
import { applyLiveSuggestion } from '../data/liveApply'
import { athleteOf, replayHeldNote, useSession, type SessionState } from '../data/engine'
import { usePlanState } from '../data/planStore'
import { useEngineMeta } from '../data/engineMeta'
import { SYNTHETIC_ROSTER_LABEL, useRoster } from '../data/roster'
import { ESTIMATE_LABEL, zoneColor } from '../data/constants'
import { acclimatizationDays, athleteTone, drillAtMinute, headsUp, minutesOverLine, overLineNow, SNAPSHOT_LABEL, type Tone } from '../data/selectors'
import { NumberTicker } from '../components/NumberTicker'
import { StatusPill } from '../components/StatusPill'
import { TempChart } from '../components/TempChart'
import { OfflineBadge } from '../components/OfflineBadge'
import { IconArrow, IconDrop, IconHeart, IconResponse } from '../components/Icons'
import { clockLabel, gearLabel } from '../lib/heat'
import { fmtCore, fmtLimit, tickerCore } from '../lib/format'
import { ease, spring } from '../lib/motion'
import { useReplayScrub } from '../lib/useReplayScrub'
import './CoachDashboard.css'

// Every number on this page is the engine's at the session minute (data/engine.ts):
// estimate, peak and status from the plan forecast or the HR-calibrated
// re-forecast, alerts from the engine's calibration gates (gates.flag).

/** Sort bucket: estimate over the line now first, then heads-up / forecast over / near, then below. */
const RANK: Record<Tone, number> = { alert: 1, watch: 2, steady: 3, none: 4 }
const rankOf = (a: AthleteLive, limit: number | null) => RANK[athleteTone(a, limit)]

interface Props {
  acked: Set<string>
  onAck: (id: string) => void
  onOpenAthlete: (id: string) => void
  onCollapse: (id: string) => void
}

export function CoachDashboard({ acked, onAck, onOpenAthlete, onCollapse }: Props) {
  const s = useSession()
  const roster = useRoster()
  const meta = useEngineMeta()
  const planState = usePlanState()
  const reduce = useReducedMotion()
  const acclimDays = acclimatizationDays(meta.sources)

  // Re-rank only by status bucket, never by the live number — rows that
  // shuffle every second would make the roster unreadable. Status changes are
  // rare, so when a row does move it's news, and the spring shows where it went.
  const statusKey = roster.athletes.map((a) => rankOf(athleteOf(s, a.id), s.limitC)).join()
  const order = useMemo(
    () => [...roster.athletes].sort((a, b) => rankOf(athleteOf(s, a.id), s.limitC) - rankOf(athleteOf(s, b.id), s.limitC)),
    // Only re-rank when a status or flag flips.
    [statusKey, roster], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // voice-plan's red alert card: only when the estimate itself is over the line now (the engine's early warning is amber).
  const alerts = order.filter((a) => overLineNow(athleteOf(s, a.id), s.limitC) && !acked.has(a.id))
  const lead = alerts[0]
  // v1.7: the engine's athlete-only re-plan for an amber heads-up (live or HR replay; never alongside the red alert).
  const suggested = lead ? null : order.find((a) => athleteOf(s, a.id).suggestion)

  const counts = roster.athletes.reduce(
    (c, a) => {
      const tone = athleteTone(athleteOf(s, a.id), s.limitC)
      return tone === 'none' ? c : { ...c, [tone]: c[tone] + 1 }
    },
    { steady: 0, watch: 0, alert: 0 },
  )
  const hasCounts = s.source === 'engine'

  const onLive = s.clock === 'live'
  const held = onLive ? null : replayHeldNote(s.replay, planState.source)
  const provenance = [
    roster.synthetic ? SYNTHETIC_ROSTER_LABEL : null,
    onLive ? s.live.label : s.source === 'engine' && s.replay.status === 'ready' ? s.replay.label : null,
    onLive ? (s.labels.find((l) => l === SNAPSHOT_LABEL) ?? null) : null,
    s.live.status === 'other_plan' ? `${s.live.label ?? 'live HR'} is running on another plan — not shown` : null,
    held,
    s.source === 'offline' ? 'offline fallback — engine unreachable, no estimates' : ESTIMATE_LABEL,
  ].filter(Boolean)

  return (
    <div className="coach">
      <LayoutGroup>
        <div className={`coach__top ${lead ? 'has-alert' : suggested ? 'has-suggestion' : ''}`}>
          <AnimatePresence mode="popLayout">
            {lead && (
              <AlertCard
                key={`alert-${lead.id}`}
                athlete={lead}
                name={roster.name(lead.id)}
                live={athleteOf(s, lead.id)}
                limit={s.limitC}
                more={alerts.length - 1}
                onAck={() => onAck(lead.id)}
                onOpen={() => onOpenAthlete(lead.id)}
                onCollapse={() => onCollapse(lead.id)}
              />
            )}
          </AnimatePresence>

          <SessionHeader s={s} compact={!!lead || !!suggested} counts={hasCounts ? counts : null} />

          <AnimatePresence mode="popLayout">
            {lead && <GuidanceCard key="guide" />}
            {suggested && (
              <SuggestionCard
                key={`suggest-${suggested.id}`}
                name={roster.name(suggested.id)}
                sug={athleteOf(s, suggested.id).suggestion!}
                onApply={() => applyLiveSuggestion(suggested.id, athleteOf(s, suggested.id).suggestion!)}
              />
            )}
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
              name={roster.name(a.id)}
              live={athleteOf(s, a.id)}
              s={s}
              acclimDays={acclimDays}
              index={i}
              onOpen={() => onOpenAthlete(a.id)}
            />
          </motion.div>
        ))}
      </div>

      <p className="coach__foot faint">
        {s.plan?.site.name ?? '—'} · {provenance.join(' · ')} · Estimates are for planning and early warning only — never a
        diagnosis. Rows without a strap show the plan forecast alone.
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
  counts: Record<'steady' | 'watch' | 'alert', number> | null
}) {
  const planState = usePlanState()
  const drills = s.drills
  const at = s.plan ? drillAtMinute(s.plan.drills, s.minute) : null
  const drill = at ? drills[at.index] : null
  const progress = s.totalMinutes > 0 ? s.minute / s.totalMinutes : 0
  const scrub = useReplayScrub(s.totalMinutes, s.minute)
  const starts = drills.map((_, i) => drills.slice(0, i).reduce((sum, d) => sum + d.minutes, 0))
  const zone = s.weather?.fhsaa_zone ?? null

  return (
    <motion.section layout transition={spring.move} className="session glass" aria-label="Practice session">
      <motion.div layout="position" transition={spring.move} className="session__inner">
        <div className="session__now">
          <div className="session__eyebrow">
            <span className="eyebrow">Now · {clockLabel(s.startHour, s.minute)}</span>
            {planState.source !== 'fixture' && (
              <span className={`session__src session__src--${planState.source}`}>
                {{ voice: 'Voice plan', optimized: 'Optimized', edited: 'Edited plan' }[planState.source]} · engine forecast
              </span>
            )}
            {s.source === 'offline' && <OfflineBadge />}
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
                {drill?.name ?? '—'}
              </motion.h2>
            </AnimatePresence>
          </div>
          <div className="session__meta muted">
            <span className="num">{Math.ceil(s.drillMinuteLeft)} min left</span>
            <span aria-hidden="true">·</span>
            <span>{drill ? gearLabel(drill.gear) : '—'}</span>
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
                <span className="session__zone-dot" style={{ background: zoneColor(zone) }} />
                {zone != null ? `Zone ${zone}` : '—'}
              </span>
            </Stat>
            <Stat label="Roster">
              <span className="session__counts num">
                <span style={{ color: 'var(--steady)' }}>{counts ? counts.steady : '—'}</span>
                <span style={{ color: 'var(--watch)' }}>{counts ? counts.watch : '—'}</span>
                <span style={{ color: 'var(--alert)' }}>{counts ? counts.alert : '—'}</span>
              </span>
            </Stat>
          </div>
        )}
      </motion.div>

      <div className="session__timeline" {...scrub} aria-label="Practice time" aria-valuetext={clockLabel(s.startHour, s.minute)}>
        {drills.map((d, i) => {
          const left = (starts[i] / Math.max(1, s.totalMinutes)) * 100
          return (
            <span
              key={d.id}
              className={`session__seg session__seg--${d.kind} ${d.id === drill?.id ? 'is-now' : ''}`}
              style={{ left: `${left}%`, width: `calc(${(d.minutes / Math.max(1, s.totalMinutes)) * 100}% - 3px)` }}
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
  limit,
  more,
  onAck,
  onOpen,
  onCollapse,
}: {
  athlete: RosterAthlete
  name: string
  live: AthleteLive
  limit: number | null
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
        <span className="eyebrow alertcard__eyebrow">Over the alert line</span>
        {more > 0 && <span className="alertcard__more num">+{more} more</span>}
      </div>
      <button className="alertcard__who pressable" onClick={onOpen}>
        <span className="display-sm">{name}</span>
        <span className="faint">
          {athlete.position ?? '—'} · Day {athlete.acclimatization_day}
        </span>
      </button>
      <div className="alertcard__temp display-lg">
        <NumberTicker value={tickerCore(live.coreC, limit, 1)} decimals={1} suffix="°C" />
      </div>
      <div className="alertcard__meta muted">
        p95 <span className="num">{fmtCore(live.coreC != null ? live.coreC + (live.bandC ?? 0) : null, limit)}</span>° ≥{' '}
        {fmtLimit(limit)}° for <span className="num">{minutesOverLine(live, limit)}</span> min
        {' '}· peak <span className="num">{fmtCore(live.peakP95C, limit)}</span>° (p95)
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

/** v1.7: the heads-up card carrying the engine's suggested change for one athlete, with Apply (same layout as below). */
function SuggestionCard({ name, sug, onApply }: { name: string; sug: LiveSuggestion; onApply: () => Promise<void> }) {
  const reduce = useReducedMotion()
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')
  const apply = async () => {
    setState('busy')
    try {
      await onApply()
    } catch {
      setState('error')
    }
  }
  return (
    <motion.section
      layout
      className="guide glass"
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateX(24px)', filter: 'blur(6px)' }}
      animate={{ opacity: 1, transform: 'translateX(0px)', filter: 'blur(0px)' }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateX(24px)', filter: 'blur(6px)', transition: { duration: 0.18 } }}
      transition={{ duration: 0.36, ease: ease.out, delay: reduce ? 0 : 0.06, layout: spring.move }}
      title={sug.labels.join(' · ')}
    >
      <div className="eyebrow" style={{ color: 'var(--watch)' }}>
        Heads-up · suggested for {name}
      </div>
      <ol className="guide__steps">
        {sug.changes.map((c) => (
          <li key={`${c.kind}-${c.drill_id}`}>{c.detail.charAt(0).toUpperCase() + c.detail.slice(1)}</li>
        ))}
      </ol>
      <div className="guide__foot">
        {sug.outcome}
        <div className="guide__actions">
          <button className="btn btn--ink pressable" onClick={apply} disabled={state === 'busy'}>
            {state === 'busy' ? 'Applying…' : 'Apply'}
          </button>
          {state === 'error' && <span className="faint">Couldn’t apply — the engine didn’t answer.</span>}
        </div>
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
      <div className="eyebrow">Heads-up</div>
      <ol className="guide__steps">
        <li>Estimate crosses the planning line</li>
        <li>Consider pulling from activity and checking on the athlete</li>
        <li>Follow your emergency action plan</li>
      </ol>
      <div className="guide__foot">
        Estimate — planning only. If an athlete collapses → <strong>Collapse response</strong>.
      </div>
    </motion.section>
  )
}

function RosterRow({
  athlete,
  name,
  live,
  s,
  acclimDays,
  index,
  onOpen,
}: {
  athlete: RosterAthlete
  name: string
  live: AthleteLive
  s: SessionState
  acclimDays: number | null
  index: number
  onOpen: () => void
}) {
  const limit = s.limitC
  const tone = athleteTone(live, limit)
  const hu = headsUp(live, limit)
  return (
    <button
      className={`row row--${tone}`}
      role="row"
      onClick={onOpen}
      style={{ ['--i' as string]: index }}
      aria-label={`${name}, estimated core ${fmtCore(live.coreC, limit, 1)} degrees, ${tone === 'none' ? 'no estimate' : tone}`}
    >
      <span className="row__who" role="cell">
        <span className="row__num num">{athlete.position ?? '—'}</span>
        <span>
          <span className="row__name">{name}</span>
          <span className="row__sub">
            {athlete.position ?? '—'} · {athlete.mass_kg} kg
          </span>
        </span>
      </span>

      <span className="row__acclim" role="cell">
        <span className="row__acclim-label num">Day {athlete.acclimatization_day}</span>
        <span className="row__ticks" aria-hidden="true">
          {Array.from({ length: acclimDays ?? 0 }, (_, i) => (
            <span key={i} className={i < athlete.acclimatization_day ? 'is-on' : ''} />
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
          <NumberTicker value={tickerCore(live.coreC, limit, 1)} decimals={1} suffix="°" />
        </span>
        {hu ? (
          <span className="row__peak num" style={{ color: 'var(--watch)' }} title={live.gates?.message}>
            {hu}
          </span>
        ) : (
          <span className="row__peak num">
            peak {fmtCore(live.peakP95C, limit)}° @ {live.peakMin != null ? Math.round(live.peakMin) : '—'}′
          </span>
        )}
      </span>

      <span className="row__spark" role="cell">
        <TempChart
          compact
          history={live.history}
          forecast={live.forecast}
          band={live.band}
          total={s.totalMinutes}
          now={s.minute}
          live={live.coreC ?? Number.NaN}
          limit={limit}
        />
      </span>

      <span className="row__status" role="cell">
        <StatusPill status={tone} size="sm" />
        <IconArrow width={16} height={16} className="row__go" />
      </span>
    </button>
  )
}
