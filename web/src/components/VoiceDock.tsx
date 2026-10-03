import { useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useVoicePlan } from '../lib/useVoicePlan'
import { useMicLevels } from '../lib/useMicLevels'
import { liveCaptionsSupported, useLiveCaptions } from '../lib/useLiveCaptions'
import { planStore, usePlanState, type PlanState } from '../data/planStore'
import type { PlanDraft } from '../data/llmPlan'
import { ROSTER } from '../data/fixtures'
import { mmss } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { NumberTicker } from './NumberTicker'
import { IconArrow, IconKeyboard, IconMic, IconSpark, IconStop } from './Icons'
import './VoiceDock.css'

// "Talk to the Twin" — the mic dock from Figma 9:65. The coach describes
// practice out loud → Gemini (engine /plan/parse_audio) transcribes and
// structures it → the coach checks the draft → /simulate models every athlete
// → optional /optimize. The AI only structures the coach's words; every heat
// number comes from the engine.

type Mode = 'idle' | 'recording' | 'transcribing' | 'review' | 'running' | 'result' | 'error' | 'typing'

const BARS = 22

const INTENSITY: Record<string, string> = { rest: 'Rest', light: 'Light', moderate: 'Moderate', hard: 'Hard', max: 'Max' }
const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }

export function VoiceDock({ onSeePlayers }: { onSeePlayers: () => void }) {
  const v = useVoicePlan()
  const p = usePlanState()
  const reduce = useReducedMotion()
  const [showResult, setShowResult] = useState(false)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const recording = v.state === 'recording'
  const captions = useLiveCaptions(recording)
  const { containerRef } = useMicLevels(recording, BARS)

  let mode: Mode = 'idle'
  if (recording) mode = 'recording'
  else if (v.state === 'processing') mode = 'transcribing'
  else if (p.phase === 'simulating' || p.phase === 'optimizing') mode = 'running'
  else if (v.state === 'error' || p.phase === 'error') mode = 'error'
  else if (v.draft && v.draft !== p.draft) mode = 'review'
  else if (showResult && p.sim) mode = 'result'
  else if (typing) mode = 'typing'

  const sheetOpen = mode === 'review' || mode === 'running' || mode === 'result' || mode === 'error' || mode === 'typing'

  const startRecording = () => {
    setTyping(false)
    setShowResult(false)
    planStore.dismissError()
    v.start()
  }

  const confirm = async (draft: PlanDraft) => {
    setShowResult(true)
    await planStore.confirm(draft)
  }

  const done = () => {
    setShowResult(false)
    setTyping(false)
    v.reset()
  }

  const submitTyped = () => {
    if (!text.trim()) return
    setTyping(false)
    setShowResult(false)
    v.submitText(text.trim())
  }

  return (
    <div className="dock" data-mode={mode}>
      <AnimatePresence>
        {sheetOpen && (
          <motion.section
            key="sheet"
            layout={!reduce}
            className="dock__sheet glass glass--strong"
            // Emerges upward out of the bar it belongs to, and returns into it.
            initial={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(100% 0% 0% 0% round 28px)', transform: 'translateY(8px)' }}
            animate={{ opacity: 1, clipPath: 'inset(0% 0% 0% 0% round 28px)', transform: 'translateY(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(100% 0% 0% 0% round 28px)', transform: 'translateY(8px)', transition: { duration: 0.2, ease: ease.out } }}
            transition={{ duration: 0.34, ease: ease.out, layout: spring.move }}
            aria-live="polite"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={sheetKey(mode, p)}
                layout={reduce ? false : 'position'}
                className="dock__content"
                initial={{ opacity: 0, filter: 'blur(4px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
                transition={{ duration: 0.24, ease: ease.out }}
              >
                {(mode === 'review' || (mode === 'running' && p.phase === 'simulating')) && (
                  <Review
                    draft={(v.draft ?? p.draft)!}
                    running={mode === 'running'}
                    onConfirm={confirm}
                    onRedo={startRecording}
                    onType={() => {
                      setText(v.draft?.transcript ?? '')
                      v.reset()
                      setTyping(true)
                    }}
                  />
                )}
                {(mode === 'result' || (mode === 'running' && p.phase === 'optimizing')) && (
                  <Result
                    p={p}
                    onSeePlayers={() => {
                      done()
                      onSeePlayers()
                    }}
                    onDone={done}
                  />
                )}
                {mode === 'error' && (
                  <ErrorView
                    message={v.error ?? p.error ?? 'Something went wrong'}
                    onRetry={() => {
                      planStore.dismissError()
                      v.reset()
                    }}
                    onType={() => {
                      planStore.dismissError()
                      v.reset()
                      setTyping(true)
                    }}
                  />
                )}
                {mode === 'typing' && (
                  <div className="dock__typing">
                    <div className="eyebrow">Type today's practice</div>
                    <textarea
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitTyped()
                      }}
                      placeholder="10 min warm-up in helmets, 20 min individual in full pads, water break, 25 min team period…"
                      rows={4}
                    />
                    <div className="dock__actions">
                      <button className="btn btn--ink pressable" onClick={submitTyped} disabled={!text.trim()}>
                        Build plan
                      </button>
                      <button className="btn btn--quiet pressable" onClick={() => setTyping(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </motion.section>
        )}
      </AnimatePresence>

      <div className="dock__bar glass glass--strong">
        <button
          className={`dock__mic pressable ${recording ? 'is-rec' : ''}`}
          onClick={recording ? v.stop : startRecording}
          disabled={mode === 'transcribing' || mode === 'running'}
          aria-label={recording ? 'Stop recording' : 'Describe today’s practice'}
        >
          <span className="dock__mic-ring" aria-hidden="true" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={recording ? 'stop' : 'mic'}
              className="dock__mic-icon"
              initial={{ opacity: 0, transform: 'scale(0.6)', filter: 'blur(3px)' }}
              animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
              exit={{ opacity: 0, transform: 'scale(0.6)', filter: 'blur(3px)' }}
              transition={{ duration: 0.18, ease: ease.out }}
            >
              {recording ? <IconStop width={20} height={20} /> : <IconMic width={24} height={24} />}
            </motion.span>
          </AnimatePresence>
        </button>

        <div className="dock__mid">
          <div className={`dock__wave ${recording ? 'is-on' : ''} ${mode === 'transcribing' ? 'is-busy' : ''}`} ref={containerRef} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => (
              <span key={i} style={{ ['--i' as string]: i }} />
            ))}
          </div>
          <div className="dock__text">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={barKey(mode)}
                className="dock__lines"
                initial={{ opacity: 0, transform: 'translateY(40%)', filter: 'blur(3px)' }}
                animate={{ opacity: 1, transform: 'translateY(0%)', filter: 'blur(0px)' }}
                exit={{ opacity: 0, transform: 'translateY(-40%)', filter: 'blur(3px)' }}
                transition={{ duration: 0.22, ease: ease.out }}
              >
                <BarText mode={mode} p={p} captions={captions} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        <div className="dock__end">
          {recording ? (
            <span className="dock__timer num">{mmss(v.seconds)}</span>
          ) : (
            <button
              className={`dock__icon pressable ${typing ? 'is-on' : ''}`}
              onClick={() => {
                setShowResult(false)
                setTyping((t) => !t)
              }}
              disabled={mode === 'transcribing' || mode === 'running'}
              aria-label="Type the plan instead"
              aria-pressed={typing}
            >
              <IconKeyboard width={20} height={20} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Gemini often returns drill names in lower case. */
function titleCase(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function sheetKey(mode: Mode, p: PlanState) {
  if (mode === 'running') return p.phase === 'simulating' ? 'review' : 'result'
  return mode
}

function barKey(mode: Mode) {
  return mode === 'review' || mode === 'result' || mode === 'error' || mode === 'typing' ? 'idle' : mode
}

function BarText({ mode, p, captions }: { mode: Mode; p: PlanState; captions: string }) {
  if (mode === 'recording') {
    return (
      <>
        <div className="dock__title">Listening…</div>
        <div className="dock__caption">
          {captions || (liveCaptionsSupported ? 'Say each drill, how long, and the gear' : 'Recording — tap stop when you’re done')}
        </div>
      </>
    )
  }
  if (mode === 'transcribing') {
    return (
      <>
        <div className="dock__title dock__shimmer">Transcribing with Gemini</div>
        <div className="dock__caption">Turning what you said into drills</div>
      </>
    )
  }
  if (mode === 'running') {
    return (
      <>
        <div className="dock__title dock__shimmer">
          {p.phase === 'optimizing' ? 'Optimizing with the twin' : `Modeling ${ROSTER.length} athletes`}
        </div>
        <div className="dock__caption">Two-node heat model · every minute of practice</div>
      </>
    )
  }
  const sub = p.source === 'fixture'
    ? 'Tap the mic and describe today’s practice'
    : `${p.source === 'optimized' ? 'Optimized plan' : 'Your plan'} is live on every athlete’s page`
  return (
    <>
      <div className="dock__title">Talk to the Twin</div>
      <div className="dock__caption">{sub}</div>
    </>
  )
}

function Review({
  draft,
  running,
  onConfirm,
  onRedo,
  onType,
}: {
  draft: PlanDraft
  running: boolean
  onConfirm: (d: PlanDraft) => void
  onRedo: () => void
  onType: () => void
}) {
  const reduce = useReducedMotion()
  const drills = draft.plan.drills
  return (
    <div className="review">
      <div className="review__head">
        <div className="eyebrow">Check the plan</div>
        <span className="review__label">{draft.labels[0] ?? 'parsed by AI — coach must confirm'}</span>
      </div>
      {draft.transcript && <blockquote className="review__quote">“{draft.transcript}”</blockquote>}

      <ol className="review__drills">
        {drills.map((d, i) => (
          <motion.li
            key={d.id}
            className={d.is_break ? 'is-break' : ''}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={{ duration: 0.26, ease: ease.out, delay: 0.08 + i * 0.04 }}
          >
            <span className="review__min num">{d.duration_min}′</span>
            <span className="review__name">{titleCase(d.name)}</span>
            <span className="review__chips">
              {!d.is_break && <span className={`chip chip--${d.intensity}`}>{INTENSITY[d.intensity]}</span>}
              <span className="chip">{d.is_break ? (d.shade ? 'Shade' : 'Break') : GEAR[d.gear]}</span>
            </span>
          </motion.li>
        ))}
      </ol>
      <div className="review__total faint num">
        {drills.length} blocks · {draft.total_min} min
      </div>

      {(draft.unclear.length > 0 || draft.assumptions.length > 0) && (
        <ul className="review__notes">
          {draft.unclear.map((u) => (
            <li key={u} className="is-unclear">
              <strong>Needs input</strong> {u}
            </li>
          ))}
          {draft.assumptions.slice(0, 4).map((a) => (
            <li key={a}>
              <strong>Check</strong> {a}
            </li>
          ))}
        </ul>
      )}

      <div className="dock__actions">
        <button className="btn btn--ink pressable" onClick={() => onConfirm(draft)} disabled={running || drills.length === 0}>
          {running ? (
            <>
              <span className="spinner" aria-hidden="true" /> Running the twin…
            </>
          ) : (
            <>
              Looks right — run the twin <IconArrow width={16} height={16} />
            </>
          )}
        </button>
        <button className="btn btn--quiet pressable" onClick={onRedo} disabled={running}>
          Re-record
        </button>
        <button className="btn btn--quiet pressable" onClick={onType} disabled={running}>
          Edit as text
        </button>
      </div>
    </div>
  )
}

function Result({ p, onSeePlayers, onDone }: { p: PlanState; onSeePlayers: () => void; onDone: () => void }) {
  const reduce = useReducedMotion()
  const sim = p.sim!
  const limit = sim.limit_core_c
  const over = sim.athletes.filter((a) => a.status === 'over_limit').length
  const near = sim.athletes.filter((a) => a.status === 'near_limit').length
  const wasOver = p.original ? p.original.athletes.filter((a) => a.status === 'over_limit').length : over
  const hottest = [...sim.athletes].sort((a, b) => b.peak_core_c_p95 - a.peak_core_c_p95).slice(0, 3)
  const name = (id: string) => ROSTER.find((r) => r.id === id)?.name ?? id
  const optimizing = p.phase === 'optimizing'
  const canOptimize = p.source !== 'optimized' && (over > 0 || near > 0 || sim.fhsaa_violations.length > 0)

  return (
    <div className="result">
      <div className="review__head">
        <div className="eyebrow">{p.source === 'optimized' ? 'Optimized plan' : 'Your plan'} · engine forecast</div>
        <span className="review__label">{sim.labels[0]}</span>
      </div>

      <div className={`result__big ${over ? 'is-over' : 'is-clear'}`}>
        <span className="display-lg">
          <NumberTicker value={over} />
        </span>
        <span className="result__big-text">
          {over === 1 ? 'athlete' : 'athletes'} forecast over {limit.toFixed(1)}°
          {p.source === 'optimized' && wasOver !== over && <span className="faint"> · was {wasOver}</span>}
          <br />
          <span className="faint num">
            {near} near the line · {sim.fhsaa_violations.length} FHSAA {sim.fhsaa_violations.length === 1 ? 'issue' : 'issues'}
          </span>
        </span>
      </div>

      {p.opt?.top_changes_text && <p className="result__changes">{p.opt.top_changes_text}</p>}
      {p.opt && (
        <p className="faint num result__kept">
          Kept {Math.round(p.opt.load_kept_pct)}% of training load · {p.opt.changes.length} changes
        </p>
      )}

      <ul className="result__hot">
        {hottest.map((a, i) => (
          <motion.li
            key={a.id}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={{ duration: 0.26, ease: ease.out, delay: 0.06 + i * 0.05 }}
          >
            <span className={`result__dot result__dot--${a.status}`} />
            <span className="result__name">{name(a.id)}</span>
            <span className="num result__peak">{a.peak_core_c_p95.toFixed(1)}°</span>
            <span className="faint num result__cross">
              {a.first_cross_min != null ? `crosses at ${Math.round(a.first_cross_min)}′` : 'stays under'}
            </span>
          </motion.li>
        ))}
      </ul>

      <div className="dock__actions">
        {canOptimize && (
          <button className="btn btn--ink pressable" onClick={() => planStore.optimize()} disabled={optimizing}>
            {optimizing ? (
              <>
                <span className="spinner" aria-hidden="true" /> Optimizing…
              </>
            ) : (
              <>
                <IconSpark width={16} height={16} /> Optimize with the twin
              </>
            )}
          </button>
        )}
        <button className={`btn ${canOptimize ? 'btn--quiet' : 'btn--ink'} pressable`} onClick={onSeePlayers} disabled={optimizing}>
          See athletes’ plans <IconArrow width={16} height={16} />
        </button>
        <button className="btn btn--quiet pressable" onClick={onDone} disabled={optimizing}>
          Done
        </button>
      </div>
    </div>
  )
}

function ErrorView({ message, onRetry, onType }: { message: string; onRetry: () => void; onType: () => void }) {
  const friendly = /permission|NotAllowed/i.test(message)
    ? 'Microphone access was blocked. Allow it in the browser, or type the plan instead.'
    : message
  return (
    <div className="dock__error">
      <div className="eyebrow">Couldn’t build the plan</div>
      <p>{friendly}</p>
      <div className="dock__actions">
        <button className="btn btn--ink pressable" onClick={onRetry}>
          Try again
        </button>
        <button className="btn btn--quiet pressable" onClick={onType}>
          Type it instead
        </button>
      </div>
    </div>
  )
}
