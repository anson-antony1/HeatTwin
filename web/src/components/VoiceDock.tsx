import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useVoicePlan } from '../lib/useVoicePlan'
import { useMicLevels } from '../lib/useMicLevels'
import { liveCaptionsSupported, useLiveCaptions } from '../lib/useLiveCaptions'
import { planStore, usePlanState, type PlanState } from '../data/planStore'
import type { PlanDraft } from '../data/llmPlan'
import { ROSTER } from '../data/fixtures'
import { useRoster } from '../data/roster'
import { mmss } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { fmtCore } from '../lib/format'
import { NumberTicker } from './NumberTicker'
import { IconArrow, IconMic, IconSpark, IconStop } from './Icons'
import { AI_NAME } from '../lib/brand'
import './VoiceDock.css'

// The voice dock (Figma 9:65) — the coach talks to the assistant (AI_NAME, lib/brand.ts).
//
// At rest it's a compact pill, exactly as wide as the sidebar. Press the mic
// and it springs out to full width (waveform, live captions, timer). Stop, and
// it springs back while the mic button runs the pipeline:
//   processing ring → check mark + "Plan updated" → mic again.
// Behind that: Gemini (engine /plan/parse_audio) transcribes and structures
// what the coach said → /simulate models every athlete → the plan goes live
// everywhere. Tap the pill's label to review what was heard, optimize, or undo.
// The AI only structures the coach's words; every heat number is the engine's.

type Bar = 'idle' | 'recording' | 'busy' | 'done'
type SheetView = 'review' | 'confirm' | 'result' | 'error' | 'typing'

const BARS = 22
const DONE_HOLD_MS = 1700

/** Island-style morph: the bar is "alive", so a whisper of bounce. */
const morph = { type: 'spring', bounce: 0.15, visualDuration: 0.5 } as const

const INTENSITY: Record<string, string> = { rest: 'Rest', light: 'Light', moderate: 'Moderate', hard: 'Hard', max: 'Max' }
const GEAR: Record<string, string> = { none: 'No pads', helmet: 'Helmet', helmet_shoulder_pads: 'Shells', full_pads: 'Full pads' }

export function VoiceDock({ onSeePlayers }: { onSeePlayers: () => void }) {
  const p = usePlanState()
  // Memory: every request carries the plan in use, so "add 20 minutes of jumping
  // jacks at the end" edits it instead of starting over.
  const v = useVoicePlan({ current_plan: p.plan })
  const reduce = useReducedMotion()
  const [opened, setOpened] = useState<'result' | 'typing' | null>(null)
  const [flash, setFlash] = useState(false)
  const [text, setText] = useState('')
  const recording = v.state === 'recording'
  const captions = useLiveCaptions(recording)
  const { containerRef } = useMicLevels(recording, BARS)
  const [appliedDraft, setAppliedDraft] = useState<PlanDraft | null>(null)
  const flashTimer = useRef<number | null>(null)

  // The AI's draft is only a draft (needs_confirmation): the coach sees every drill, assumption and unclear item and
  // presses Confirm before the engine runs. A draft with no usable drills stops for the coach instead.
  const confirmDraft = (d: PlanDraft) => {
    if (appliedDraft === d) return
    setAppliedDraft(d)
    planStore.confirm(d).then(() => {
      if (planStore.get().phase !== 'ready') return
      setFlash(true)
      flashTimer.current = window.setTimeout(() => {
        setFlash(false)
        v.reset()
      }, DONE_HOLD_MS)
    })
  }

  useEffect(() => () => {
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
  }, [])

  const busy = v.state === 'processing' || p.phase === 'simulating' || p.phase === 'optimizing'
  const bar: Bar = recording ? 'recording' : busy && !opened ? 'busy' : flash ? 'done' : 'idle'
  const errorMsg = v.state === 'error' ? v.error : p.phase === 'error' ? p.error : null

  let sheet: SheetView | null = null
  if (errorMsg) sheet = 'error'
  else if (v.draft && v.draft.plan.drills.length === 0) sheet = 'review'
  else if (v.draft && appliedDraft !== v.draft) sheet = 'confirm'
  else if (opened === 'typing') sheet = 'typing'
  else if (opened === 'result' && p.sim) sheet = 'result'

  const startRecording = () => {
    setOpened(null)
    setFlash(false)
    planStore.dismissError()
    v.start()
  }

  const close = () => {
    setOpened(null)
    if (v.state !== 'processing') v.reset()
  }

  const openTyping = (prefill = '') => {
    planStore.dismissError()
    v.reset()
    setText(prefill)
    setOpened('typing')
  }

  const submitTyped = () => {
    if (!text.trim()) return
    setOpened(null)
    v.submitText(text.trim())
  }

  const onLabel = () => {
    if (bar !== 'idle') return
    if (p.sim) setOpened((o) => (o === 'result' ? null : 'result'))
    else setOpened((o) => (o === 'typing' ? null : 'typing'))
  }

  const busyLabel =
    v.state === 'processing'
      ? ['Thinking', `${AI_NAME} · ${p.source === 'fixture' ? 'new plan' : 'editing plan'}`]
      : p.phase === 'optimizing'
        ? ['Optimizing', AI_NAME]
        : ['Modeling', `${ROSTER.length} athletes`]

  return (
    <div className="dock" data-bar={bar}>
      <AnimatePresence>
        {sheet && (
          <motion.section
            key="sheet"
            layout={!reduce}
            className="dock__sheet glass glass--strong"
            // Emerges upward out of the pill it belongs to, and returns into it.
            initial={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(100% 0% 0% 0% round 28px)', transform: 'translateY(8px)' }}
            animate={{ opacity: 1, clipPath: 'inset(0% 0% 0% 0% round 28px)', transform: 'translateY(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(100% 0% 0% 0% round 28px)', transform: 'translateY(8px)', transition: { duration: 0.2, ease: ease.out } }}
            transition={{ duration: 0.34, ease: ease.out, layout: spring.move }}
            aria-live="polite"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={sheet}
                layout={reduce ? false : 'position'}
                className="dock__content"
                initial={{ opacity: 0, filter: 'blur(4px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
                transition={{ duration: 0.24, ease: ease.out }}
              >
                {sheet === 'review' && v.draft && (
                  <Review draft={v.draft} onRedo={startRecording} onType={() => openTyping(v.draft?.transcript ?? '')} />
                )}
                {sheet === 'confirm' && v.draft && (
                  <Confirm
                    draft={v.draft}
                    onConfirm={() => v.draft && confirmDraft(v.draft)}
                    onRedo={startRecording}
                    onType={() => openTyping(v.draft?.transcript ?? '')}
                  />
                )}
                {sheet === 'result' && (
                  <Result
                    p={p}
                    onSeePlayers={() => {
                      close()
                      onSeePlayers()
                    }}
                    onType={() => openTyping(p.draft?.transcript ?? '')}
                    onDone={close}
                  />
                )}
                {sheet === 'error' && (
                  <ErrorView
                    message={errorMsg ?? 'Something went wrong'}
                    onRetry={() => {
                      planStore.dismissError()
                      v.reset()
                    }}
                    onType={() => openTyping()}
                  />
                )}
                {sheet === 'typing' && (
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
                      <button className="btn btn--quiet pressable" onClick={close}>
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

      <motion.div
        layout={!reduce}
        transition={morph}
        className={`dock__bar glass glass--strong ${bar === 'recording' ? 'is-wide' : ''}`}
        style={{ borderRadius: 30 }}
      >
        <motion.button
          layout={!reduce}
          transition={morph}
          className={`dock__mic dock__mic--${bar}`}
          onClick={recording ? v.stop : startRecording}
          disabled={bar === 'busy' || bar === 'done'}
          aria-label={recording ? 'Stop recording' : `Ask ${AI_NAME}`}
          style={{ borderRadius: 999 }}
        >
          <span className="dock__mic-ring" aria-hidden="true" />
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={bar}
              className="dock__mic-icon"
              initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.6)', filter: 'blur(3px)' }}
              animate={{ opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.6)', filter: 'blur(3px)' }}
              transition={{ duration: 0.2, ease: ease.out }}
            >
              {bar === 'recording' && <IconStop width={20} height={20} />}
              {bar === 'idle' && <IconMic width={24} height={24} />}
              {bar === 'busy' && <Spinner />}
              {bar === 'done' && <Check />}
            </motion.span>
          </AnimatePresence>
        </motion.button>

        <motion.div layout={reduce ? false : 'position'} transition={morph} className="dock__mid">
          <div className={`dock__wave ${recording ? 'is-on' : ''}`} ref={containerRef} aria-hidden="true">
            {Array.from({ length: BARS }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <button className="dock__text" onClick={onLabel} disabled={bar !== 'idle'} tabIndex={bar === 'idle' ? 0 : -1}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={bar === 'busy' ? `busy-${busyLabel[0]}` : bar}
                className="dock__lines"
                initial={{ opacity: 0, transform: 'translateY(40%)', filter: 'blur(3px)' }}
                animate={{ opacity: 1, transform: 'translateY(0%)', filter: 'blur(0px)' }}
                exit={{ opacity: 0, transform: 'translateY(-40%)', filter: 'blur(3px)' }}
                transition={{ duration: 0.22, ease: ease.out }}
              >
                <BarText bar={bar} p={p} captions={captions} busyLabel={busyLabel} />
              </motion.span>
            </AnimatePresence>
          </button>
        </motion.div>

        {recording && (
          <motion.span
            layout={reduce ? false : 'position'}
            className="dock__timer num"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, delay: 0.15 }}
          >
            {mmss(v.seconds)}
          </motion.span>
        )}
      </motion.div>
    </div>
  )
}

/** Processing ring: constant motion, so linear. */
function Spinner() {
  return (
    <svg className="dock__spinner" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
      <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <circle cx="15" cy="15" r="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="22 76" />
    </svg>
  )
}

/** The check draws itself in — a one-off moment, so it gets a little longer. */
function Check() {
  const reduce = useReducedMotion()
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: reduce ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.36, ease: ease.out, delay: 0.06 }}
      />
    </svg>
  )
}

/** Gemini often returns drill names in lower case. */
function titleCase(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function BarText({ bar, p, captions, busyLabel }: { bar: Bar; p: PlanState; captions: string; busyLabel: string[] }) {
  if (bar === 'recording') {
    return (
      <>
        <span className="dock__title">Listening…</span>
        <span className="dock__caption">
          {captions || (liveCaptionsSupported ? 'Say each drill, how long, and the gear' : 'Tap stop when you’re done')}
        </span>
      </>
    )
  }
  if (bar === 'busy') {
    return (
      <>
        <span className="dock__title dock__shimmer">{busyLabel[0]}…</span>
        <span className="dock__caption">{busyLabel[1]}</span>
      </>
    )
  }
  if (bar === 'done') {
    const mins = Math.round(p.plan.drills.reduce((s, d) => s + d.duration_min, 0))
    const change = p.draft?.edited ? p.draft.changes?.[0] : null
    return (
      <>
        <span className="dock__title">Plan updated</span>
        <span className="dock__caption num">{change ?? `${p.plan.drills.length} blocks · ${mins} min`}</span>
      </>
    )
  }
  return (
    <>
      <span className="dock__title">Ask {AI_NAME}</span>
      <span className="dock__caption">{p.source === 'fixture' ? 'Tap mic to plan' : 'Tap mic to change'}</span>
    </>
  )
}

function Review({ draft, onRedo, onType }: { draft: PlanDraft; onRedo: () => void; onType: () => void }) {
  return (
    <div className="review">
      <div className="review__head">
        <div className="eyebrow">Didn’t catch a plan</div>
        <span className="review__label">{draft.labels[0] ?? 'parsed by AI'}</span>
      </div>
      {draft.transcript && <blockquote className="review__quote">“{draft.transcript}”</blockquote>}
      {draft.unclear.length > 0 && (
        <ul className="review__notes">
          {draft.unclear.map((u) => (
            <li key={u} className="is-unclear">
              <strong>Needs input</strong> {u}
            </li>
          ))}
        </ul>
      )}
      <div className="dock__actions">
        <button className="btn btn--ink pressable" onClick={onRedo}>
          Try again
        </button>
        <button className="btn btn--quiet pressable" onClick={onType}>
          Edit as text
        </button>
      </div>
    </div>
  )
}

function Confirm({ draft, onConfirm, onRedo, onType }: {
  draft: PlanDraft
  onConfirm: () => void
  onRedo: () => void
  onType: () => void
}) {
  return (
    <div className="review">
      <div className="review__head">
        <div className="eyebrow">Check this draft</div>
        <span className="review__label">{draft.labels[0] ?? 'parsed by AI — coach must confirm'}</span>
      </div>
      {draft.transcript && <blockquote className="review__quote">“{draft.transcript}”</blockquote>}
      <Drills draft={draft} />
      <div className="dock__actions">
        <button className="btn btn--ink pressable" onClick={onConfirm}>
          Confirm and run the twin
        </button>
        <button className="btn btn--quiet pressable" onClick={onRedo}>
          Try again
        </button>
        <button className="btn btn--quiet pressable" onClick={onType}>
          Edit as text
        </button>
      </div>
    </div>
  )
}

function Drills({ draft }: { draft: PlanDraft }) {
  const reduce = useReducedMotion()
  return (
    <>
      <ol className="review__drills">
        {draft.plan.drills.map((d, i) => (
          <motion.li
            key={d.id}
            className={d.is_break ? 'is-break' : ''}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={{ duration: 0.26, ease: ease.out, delay: 0.06 + i * 0.035 }}
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
      {(draft.assumptions.length > 0 || draft.unclear.length > 0) && (
        <ul className="review__notes">
          {draft.unclear.map((u) => (
            <li key={u} className="is-unclear">
              <strong>Needs input</strong> {u}
            </li>
          ))}
          {draft.assumptions.map((a) => (
            <li key={a}>
              <strong>Check</strong> {a}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function Result({
  p,
  onSeePlayers,
  onType,
  onDone,
}: {
  p: PlanState
  onSeePlayers: () => void
  onType: () => void
  onDone: () => void
}) {
  const reduce = useReducedMotion()
  const sim = p.sim!
  const limit = sim.limit_core_c
  const over = sim.athletes.filter((a) => a.status === 'over_limit').length
  const near = sim.athletes.filter((a) => a.status === 'near_limit').length
  const wasOver = p.original ? p.original.athletes.filter((a) => a.status === 'over_limit').length : over
  const hottest = [...sim.athletes].sort((a, b) => b.peak_core_c_p95 - a.peak_core_c_p95).slice(0, 3)
  const roster = useRoster()
  // Engine roster names (with "(fictional)" for the synthetic demo roster); else the local fixture copy, which keeps it too.
  const name = (id: string) => (roster.byId(id) ? roster.name(id) : (ROSTER.find((r) => r.id === id)?.name ?? id))
  const optimizing = p.phase === 'optimizing'
  const canOptimize = p.source !== 'optimized' && (over > 0 || near > 0 || sim.fhsaa_violations.length > 0)

  return (
    <div className="result">
      <div className="review__head">
        <div className="eyebrow">{p.source === 'optimized' ? 'Optimized plan' : 'Your plan'} · {AI_NAME}</div>
        <span className="review__label">{sim.labels[0]}</span>
      </div>

      <div className={`result__big ${over ? 'is-over' : 'is-none-over'}`}>
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

      {p.draft?.transcript && p.source === 'voice' && (
        <blockquote className="review__quote">
          <span className="eyebrow">{AI_NAME} heard</span> “{p.draft.transcript}”
        </blockquote>
      )}
      {p.draft?.edited && p.draft.changes && p.draft.changes.length > 0 && p.source === 'voice' && (
        <ul className="result__edits">
          {p.draft.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
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
            <span className="num result__peak">{fmtCore(a.peak_core_c_p95, limit)}°</span>
            <span className="faint num result__cross">
              {a.first_cross_min != null ? `crosses at ${Math.round(a.first_cross_min)}′` : 'below the line (estimate)'}
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

      {p.source === 'voice' && p.draft && (
        <details className="result__details">
          <summary>What the twin is running · {p.plan.drills.length} blocks</summary>
          <Drills draft={p.draft} />
        </details>
      )}

      <div className="result__quiet">
        <button className="linkbtn" onClick={onType} disabled={optimizing}>
          Type a correction
        </button>
        {p.source !== 'fixture' && (
          <button className="linkbtn" onClick={() => planStore.clear()} disabled={optimizing}>
            Start a new plan
          </button>
        )}
        {p.previous && (
          <button className="linkbtn" onClick={() => planStore.undo()} disabled={optimizing}>
            Undo {p.source === 'optimized' ? 'optimization' : 'this plan'}
          </button>
        )}
      </div>
    </div>
  )
}

function ErrorView({ message, onRetry, onType }: { message: string; onRetry: () => void; onType: () => void }) {
  const friendly = /permission|NotAllowed/i.test(message)
    ? 'Microphone access was blocked. Allow it in the browser, or type the plan instead.'
    : /Failed to fetch|NetworkError|Load failed|reach the engine|ECONNREFUSED|HTTP 50[02]: ?$|^Internal Server Error$/i.test(message)
      ? 'Can’t reach the HeatTwin engine. Start it from the repo root with `.venv/bin/uvicorn engine.api:app --port 8000`, then try again.'
      : /timed out|took too long|TimeoutError/i.test(message)
        ? 'That took too long — the engine or Gemini didn’t answer within a minute. Try again.'
      : /GEMINI_API_KEY/i.test(message)
        ? 'The engine has no Gemini key. Add GEMINI_API_KEY to .env at the repo root and restart the engine.'
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
