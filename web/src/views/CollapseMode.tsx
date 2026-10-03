import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ROSTER } from '../data/fixtures'
import { HoldButton } from '../components/HoldButton'
import { IconCheck, IconPhone, IconVolume } from '../components/Icons'
import { mmss } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { useCwiTargets, useNodeLatest } from './collapse/hooks'
import { EAP_NOTE, buildSteps, nataGoalText, nataWindowLabel, noRectalNote } from './collapse/targets'
import { NO_PROBE_TEXT, TUB_TITLE, formatAge, formatNodeClock, tubDisplay, tubHandoffLine, tubVerdict } from './collapse/tub'
import './CollapseMode.css'

// Collapse mode: cool first, transport second. Runs on wall-clock time, not
// demo time. Voice uses the browser's speech engine as a stand-in for the
// pre-generated ElevenLabs clips (swap `speak` for <audio> playback).
// Nothing here decides when to stop cooling: HeatTwin only quotes KSI / NATA
// with attribution, and rectal temperature is the only basis for treatment
// decisions. Every number (water limit, cooling times, NATA goal) comes from
// GET /sources, and the tub temperature only from a real field-node reading
// (GET /node/latest); with neither, the text shows without numbers.

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
  const athlete = ROSTER.find((a) => a.id === athleteId)!
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(startedAt)
  const [done, setDone] = useState<Record<string, number>>({})
  const [voice, setVoice] = useState(true)
  const [log, setLog] = useState<LogEntry[]>(() => [
    // No planning estimate in the emergency log: only a rectal temperature informs care (KSI).
    { t: 0, text: `Collapse mode started — ${athlete.name}` },
  ])
  const [copied, setCopied] = useState(false)
  const targets = useCwiTargets()
  const steps = useMemo(() => buildSteps(targets), [targets])
  const { latest, status: nodeStatus } = useNodeLatest()

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])

  const elapsed = (now - startedAt) / 1000
  const current = steps.find((st) => done[st.id] == null) ?? null
  const immersedAt = done.tub
  const immersion = immersedAt != null ? elapsed - immersedAt : null

  // Tub temperature: only a numeric tub_temp_c from the field node. No probe, no number.
  const tub = tubDisplay(latest)
  const verdict = tubVerdict(tub, targets)
  const tubAge = tub.kind === 'reading' ? formatAge(tub.ts, now) : null

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

  const complete = (st: { id: string; title: string }) => {
    if (done[st.id] != null) return
    setDone((d) => ({ ...d, [st.id]: elapsed }))
    setLog((l) => [...l, { t: elapsed, text: st.title }])
  }

  const copy = async () => {
    const text = [
      `HeatTwin — EMS handoff · ${athlete.name} (${athlete.position}, ${athlete.massKg} kg, roster entry)`,
      `Times are since Collapse mode started on this screen.`,
      ...log.map((e) => `+${mmss(e.t)}  ${e.text}`),
      tubHandoffLine(tub),
      'Core temperature figures above are model estimates — planning only, not measurements.',
      'Rectal temperature is the only basis for treatment decisions.',
    ].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the log stays on screen */
    }
  }

  // The ring fills toward the NATA goal window from /sources; with no window it stays empty.
  const goalSec = targets.nataGoalF != null && targets.nataGoalWindowMin != null ? targets.nataGoalWindowMin * 60 : null
  const ring = goalSec ? Math.min(1, elapsed / goalSec) : 0
  // KSI no-rectal-reading range from /sources; the bar below only draws when it is known.
  const [rectalMin, rectalMax] = targets.noRectalCoolMin ?? [null, null]
  const R = 120
  const C = 2 * Math.PI * R

  return (
    <motion.div
      className="collapse"
      role="dialog"
      aria-modal="true"
      aria-label={`Collapse response for ${athlete.name}`}
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
              {athlete.name}
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
              <div className="eyebrow">Since Collapse mode started</div>
              <div className="collapse__digits num">{mmss(elapsed)}</div>
              <div className="collapse__target" title={targets.nataSource ?? undefined}>
                {nataWindowLabel(targets)}
              </div>
            </div>
          </section>

          {/* Steps */}
          <section className="collapse__steps" aria-label="Steps">
            {steps.map((st, i) => {
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
                          <span>
                            {st.detail}
                            <span className="cstep__src" title={targets.ksiSource ?? undefined}>
                              Source: {st.source}
                            </span>
                          </span>
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
            <div className="ccard" aria-label={tub.kind === 'none' ? tub.full : undefined}>
              <div className="eyebrow">{TUB_TITLE}</div>
              {tub.kind === 'reading' ? (
                <>
                  <div className="ccard__big num">{tub.fText}</div>
                  <div className="ccard__sub num">{tub.cText}</div>
                  {verdict && (
                    <div className={`ccard__ok ${verdict.under ? 'is-ok' : ''}`} title={targets.ksiSource ?? undefined}>
                      {verdict.text}
                    </div>
                  )}
                  <div className="ccard__note">
                    Field-node probe · reading at {formatNodeClock(tub.ts)}
                    {tubAge ? ` (${tubAge})` : ''}
                    {tub.labels.length > 0 ? ` · ${tub.labels.join(' · ')}` : ''}
                  </div>
                </>
              ) : (
                <>
                  <div className="ccard__big ccard__big--text">No probe connected</div>
                  <div className="ccard__note">
                    {nodeStatus === 'unreachable'
                      ? `Field-node data unavailable right now (${NO_PROBE_TEXT}).`
                      : 'Shows a reading only when the field node posts a tub temperature.'}
                  </div>
                </>
              )}
            </div>
            <div className="ccard">
              <div className="eyebrow">Cooling goal</div>
              <div className="ccard__goal" title={targets.nataSource ?? undefined}>
                {nataGoalText(targets)}
              </div>
            </div>
            <div className="ccard">
              <div className="eyebrow">In the water</div>
              <div className="ccard__big num">{immersion == null ? '—' : mmss(immersion)}</div>
              {rectalMin != null && rectalMax != null && (
                <div className="ccard__bar" aria-hidden="true">
                  <span className="ccard__bar-band" style={{ left: `${(rectalMin / rectalMax) * 100}%` }} />
                  <span
                    className="ccard__bar-fill"
                    style={{ transform: `scaleX(${immersion == null ? 0 : Math.min(1, immersion / (rectalMax * 60))})` }}
                  />
                </div>
              )}
              <div className="ccard__note" title={targets.ksiSource ?? undefined}>
                {noRectalNote(targets)}
              </div>
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
          <p>{EAP_NOTE}</p>
          <p>
            Rectal temperature is the only basis for treatment decisions (KSI, MHSAA). HeatTwin does not decide when
            cooling ends; estimates on this screen are planning only and are not a basis for that decision.
          </p>
        </footer>
      </motion.div>
    </motion.div>
  )
}
