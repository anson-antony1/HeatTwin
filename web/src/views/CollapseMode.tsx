import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { athleteOf, useSession } from '../data/engine'
import { engineMeta, useEngineMeta } from '../data/engineMeta'
import { useRoster } from '../data/roster'
import { cwiTargets, fmtRange, minutesClock, tubLimitF, tubReadingF, type CwiTargets } from '../data/cwi'
import { fmtCore } from '../lib/format'
import { HoldButton } from '../components/HoldButton'
import { IconCheck, IconPhone, IconVolume } from '../components/Icons'
import { mmss } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import './CollapseMode.css'

// Collapse mode: cool first, transport second. Runs on wall-clock time, not
// demo time. Voice uses the browser's speech engine as a stand-in for the
// pre-generated ElevenLabs clips (swap `speak` for <audio> playback).
// Nothing here decides when cooling ends — that's rectal temperature only.
// Numbers: KSI / NATA values from GET /sources, the tub probe from GET
// /node/latest ("—" until a probe is wired), the estimate from the engine.

/** How often Collapse mode re-reads /node/latest (UI refresh rate, not a physiological value). */
const NODE_POLL_MS = 5000

interface Step {
  id: string
  title: string
  detail: string
  say: string
}

function steps(t: CwiTargets): Step[] {
  const r = t.noRectalCoolMin
  return [
  {
    id: 'call',
    title: 'Call 911',
    detail: 'Say “suspected exertional heat stroke.” Send someone to meet EMS at the gate.',
    say: 'Call nine one one now. Say suspected exertional heat stroke. Send someone to meet the ambulance.',
  },
  {
    id: 'tub',
    title: 'Into the tub',
    detail: 'Immerse to the neck in ice water. Support the head above water.',
    say: 'Get the athlete into the ice tub, up to the neck. Hold the head above the water.',
  },
  {
    id: 'stir',
    title: 'Stir the water',
    detail: 'Keep the water moving the whole time. Add ice as it melts.',
    say: 'Keep stirring the water. Add ice as it melts. Do not stop cooling.',
  },
  {
    id: 'cool',
    title: 'Keep cooling',
    detail: `Without a rectal thermometer, cool ${fmtRange(r)} minutes before removing.`,
    say: r
      ? `Keep cooling. Without a rectal thermometer, cool for ${r[0]} to ${r[1]} minutes.`
      : 'Keep cooling. Without a rectal thermometer, follow the cooling time in the KSI guide.',
  },
  {
    id: 'handoff',
    title: 'Hand off to EMS',
    detail: 'Remove from the tub, then transport. Share the timeline below.',
    say: 'Now remove the athlete from the tub and hand off to E M S. Share the timeline.',
  },
  ]
}

interface LogEntry {
  t: number
  text: string
}

function speak(text: string) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.02
  window.speechSynthesis.speak(u)
}

export function CollapseMode({ athleteId, onClose }: { athleteId: string; onClose: () => void }) {
  const reduce = useReducedMotion()
  const s = useSession()
  const meta = useEngineMeta()
  const roster = useRoster()
  const targets = cwiTargets(meta.sources)
  const STEPS = steps(targets)
  const athlete = roster.byId(athleteId)
  const name = roster.name(athleteId)
  const position = athlete?.position ?? '—'
  const live = athleteOf(s, athleteId)
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  const [done, setDone] = useState<Record<string, number>>({})
  const [voice, setVoice] = useState(true)
  const [log, setLog] = useState<LogEntry[]>(() => [
    { t: 0, text: `Collapse mode started — ${name} · ${position}` },
    { t: 0, text: `Last est. core ${fmtCore(live.coreC, s.limitC, 1)} °F (estimate, not a measurement)` },
  ])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  // The tub probe arrives through the field node (GET /node/latest).
  useEffect(() => {
    void engineMeta.refreshNode()
    const id = setInterval(() => void engineMeta.refreshNode(), NODE_POLL_MS)
    return () => clearInterval(id)
  }, [])

  const elapsed = (now - startedAt) / 1000
  const current = STEPS.find((st) => done[st.id] == null) ?? null
  const immersedAt = done.tub
  const immersion = immersedAt != null ? elapsed - immersedAt : null

  // Tub probe: the node's reading, or none (no stand-in).
  const tubF = tubReadingF(meta.node)
  const limitF = tubLimitF(targets)
  const tubLine = tubF != null ? `Tub water ${tubF.toFixed(1)} °F` : 'Tub water — (no tub probe reading)'

  useEffect(() => {
    if (voice && current) speak(current.say)
  }, [current?.id, voice]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => window.speechSynthesis?.cancel(), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault() // exiting needs the hold, by design
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const complete = (st: Step) => {
    if (done[st.id] != null) return
    setDone((d) => ({ ...d, [st.id]: elapsed }))
    setLog((l) => [...l, { t: elapsed, text: st.title }])
  }

  const copy = async () => {
    const text = [
      `HeatTwin — EMS handoff · ${roster.fullName(athleteId)} (${position}, ${athlete?.mass_kg ?? '—'} kg)`,
      ...log.map((e) => `+${mmss(e.t)}  ${e.text}`),
      tubLine,
      'Core temperatures above are model estimates, not measurements.',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the log stays on screen */
    }
  }

  // NATA cooling-goal window from /sources (nata_ehs.goal_below_f_within_<N>min).
  const target = targets.nataGoalWindowMin != null ? targets.nataGoalWindowMin * 60 : null
  const ring = target ? Math.min(1, elapsed / target) : 0
  const coolFor = targets.noRectalCoolMin
  const R = 120
  const C = 2 * Math.PI * R

  return (
    <motion.div
      className="collapse"
      role="dialog"
      aria-modal="true"
      aria-label={`Collapse response for ${name}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={{ duration: 0.25, ease: ease.out }}
    >
      <motion.div
        className="collapse__panel"
        initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.96)' }}
        animate={{ opacity: 1, transform: 'scale(1)' }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.98)', transition: { duration: 0.18 } }}
        transition={{ duration: 0.3, ease: ease.out }}
      >
        <header className="collapse__bar">
          <div className="collapse__title">
            <span className="collapse__live" aria-hidden="true" />
            <span className="eyebrow">Collapse response</span>
            <span className="collapse__who">
              {name} · {position}
            </span>
          </div>
          <div className="collapse__bar-actions">
            <button
              className={`collapse__voice pressable ${voice ? 'is-on' : ''}`}
              onClick={() => {
                if (voice) window.speechSynthesis?.cancel()
                setVoice((v) => !v)
              }}
              aria-pressed={voice}
            >
              <IconVolume width={18} height={18} /> Voice {voice ? 'on' : 'off'}
            </button>
            <HoldButton onConfirm={onClose} hint="Hold to end the response">
              Hold to end
            </HoldButton>
          </div>
        </header>

        <div className="collapse__grid">
          {/* Clock */}
          <section className="collapse__clock">
            <svg viewBox="0 0 280 280" className="collapse__ring" aria-hidden="true">
              <circle cx="140" cy="140" r={R} className="collapse__ring-track" />
              <circle
                cx="140"
                cy="140"
                r={R}
                className="collapse__ring-fill"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - ring)}
                transform="rotate(-90 140 140)"
              />
            </svg>
            <div className="collapse__time">
              <div className="eyebrow">Since collapse</div>
              <div className="collapse__digits num">{mmss(elapsed)}</div>
              <div className="collapse__target">Cool within {minutesClock(targets.nataGoalWindowMin)}</div>
            </div>
          </section>

          {/* Steps */}
          <section className="collapse__steps" aria-label="Steps">
            {STEPS.map((st, i) => {
              const isDone = done[st.id] != null
              const isNow = current?.id === st.id
              return (
                <motion.button
                  key={st.id}
                  layout={!reduce}
                  transition={spring.move}
                  className={`cstep ${isDone ? 'is-done' : ''} ${isNow ? 'is-now' : ''}`}
                  onClick={() => complete(st)}
                  disabled={isDone}
                  aria-current={isNow ? 'step' : undefined}
                >
                  <span className="cstep__idx num">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {isDone ? (
                        <motion.span
                          key="done"
                          initial={{ opacity: 0, transform: 'scale(0.6)', filter: 'blur(3px)' }}
                          animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
                          transition={{ duration: 0.22, ease: ease.out }}
                        >
                          <IconCheck width={16} height={16} />
                        </motion.span>
                      ) : (
                        <motion.span key="n" exit={{ opacity: 0, transform: 'scale(0.6)' }} transition={{ duration: 0.12 }}>
                          {i + 1}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className="cstep__body">
                    <span className="cstep__title">
                      {st.id === 'call' && <IconPhone width={16} height={16} />} {st.title}
                    </span>
                    <AnimatePresence initial={false}>
                      {isNow && (
                        <motion.span
                          className="cstep__detail"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22, ease: ease.out }}
                        >
                          <span>{st.detail}</span>
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </span>
                  <span className="cstep__time num">
                    {isDone ? `+${mmss(done[st.id])}` : isNow ? 'Tap when done' : ''}
                  </span>
                </motion.button>
              )
            })}
          </section>

          {/* Tub + immersion */}
          <section className="collapse__side">
            <div className="ccard">
              <div className="eyebrow">Tub water · probe</div>
              <div className="ccard__big num">{tubF != null ? tubF.toFixed(1) : '—'}°F</div>
              <div className={`ccard__ok ${tubF != null && limitF != null && tubF < limitF ? 'is-ok' : ''}`}>
                {tubF == null || limitF == null
                  ? `No probe reading · KSI: under ${limitF ?? '—'} °F`
                  : tubF < limitF
                    ? `Under ${limitF} °F — cold enough`
                    : `Add ice — over ${limitF} °F`}
              </div>
            </div>
            <div className="ccard">
              <div className="eyebrow">In the water</div>
              <div className="ccard__big num">{immersion == null ? '—' : mmss(immersion)}</div>
              <div className="ccard__bar" aria-hidden="true">
                <span className="ccard__bar-band" />
                <span
                  className="ccard__bar-fill"
                  style={{ transform: `scaleX(${immersion == null || !coolFor ? 0 : Math.min(1, immersion / (coolFor[1] * 60))})` }}
                />
              </div>
              <div className="ccard__note">{fmtRange(coolFor)} min without a rectal reading</div>
            </div>
          </section>

          {/* EMS timeline */}
          <section className="collapse__log">
            <div className="collapse__log-head">
              <span className="eyebrow">EMS handoff timeline</span>
              <button className="collapse__copy pressable" onClick={copy}>
                {copied ? 'Copied' : 'Copy for EMS'}
              </button>
            </div>
            <ol>
              <AnimatePresence initial={false}>
                {log.map((e, i) => (
                  <motion.li
                    key={`${i}-${e.text}`}
                    initial={{ opacity: 0, transform: 'translateY(-6px)' }}
                    animate={{ opacity: 1, transform: 'translateY(0px)' }}
                    transition={{ duration: 0.22, ease: ease.out }}
                  >
                    <span className="num">+{mmss(e.t)}</span>
                    {e.text}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </section>
        </div>

        <footer className="collapse__foot">
          Only a rectal temperature can tell you when cooling can end. Estimates on this screen are never a reason to end
          it.
        </footer>
      </motion.div>
    </motion.div>
  )
}
