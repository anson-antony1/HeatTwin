import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { NO_RECOGNIZER, useVoicePlan } from '../lib/useVoicePlan'
import { useMicLevels } from '../lib/useMicLevels'
import { liveCaptionsSupported, useLiveCaptions } from '../lib/useLiveCaptions'
import { planStore, usePlanState, type PlanState } from '../data/planStore'
import type { PlanDraft } from '../data/llmPlan'
import { useRoster } from '../data/roster'
import { hasDigits, kelvin, useKelvinReply } from '../data/voiceReply'
import { HELD_MESSAGE, provenanceLabels, type VoiceOutcome } from '../data/voiceFlow'
import { speakSentence, speechAvailable, stopSpeaking } from '../lib/speak'
import { dockSheet } from '../lib/dockSheet'
import { fmtCore, fmtLimit } from '../lib/format'
import { mmss } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { NumberTicker } from './NumberTicker'
import { IconArrow, IconMic, IconSpark, IconStop } from './Icons'
import { AI_NAME } from '../lib/brand'
import './VoiceDock.css'

// The voice dock (Figma 9:65) — the coach talks to the assistant (AI_NAME, lib/brand.ts).
//
// At rest it's a compact pill, exactly as wide as the sidebar. Press the mic
// and it springs out to full width (waveform, live captions, timer). Stop, and
// it springs back while the mic button runs the pipeline:
//   processing ring → Confirm sheet → check mark + "Plan updated" → mic again.
// Behind that: Gemini (engine /plan/parse_audio) transcribes and structures
// what the coach said → the coach checks the draft and presses Confirm →
// /simulate models every athlete → the plan goes live everywhere. Tap the
// pill's label to review the result, optimize, or undo.
// The AI only structures the coach's words; every heat number is the engine's,
// and Kelvin's sentence is engine-written (/voice/answer), guarded and
// number-checked before it is shown (data/voiceReply.ts).
//
// Free path (no paid API; Gemini is optional and off): the transcript comes from
// the browser's Web Speech API (or the engine's offline Whisper), the engine's
// decision layer (engine/decide.py) routes it — a plan to confirm, a question
// answered by the engine's own sentence (guarded, number-checked, then spoken by
// the browser's voice), or "Did you mean …?" with the two most probable options
// when it is not sure (data/voiceFlow.ts).

type Bar = 'idle' | 'recording' | 'busy' | 'done'

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
  const transcriptRef = useRef<() => string>(() => '')
  const v = useVoicePlan({ current_plan: p.plan }, { getTranscript: () => transcriptRef.current() })
  const reduce = useReducedMotion()
  const roster = useRoster()
  const [opened, setOpened] = useState<'result' | 'typing' | null>(null)
  const [flash, setFlash] = useState(false)
  const [text, setText] = useState('')
  const recording = v.state === 'recording'
  const { text: captions, latest: latestCaptions } = useLiveCaptions(recording)
  useEffect(() => {
    transcriptRef.current = () => latestCaptions.current
  }, [latestCaptions])
  const { containerRef } = useMicLevels(recording, BARS)
  const [appliedDraft, setAppliedDraft] = useState<PlanDraft | null>(null)
  const flashTimer = useRef<number | null>(null)
  const reply = useKelvinReply()

  // The AI's draft is only a draft (needs_confirmation): the coach sees every
  // drill and note and presses Confirm before the engine runs; the check mark
  // confirms it landed. A draft with no usable drills stops for the coach.
  const confirmDraft = (d: PlanDraft) => {
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

  const outcome = v.outcome && v.outcome.kind !== 'draft' ? v.outcome : null
  const sheet = dockSheet({ errorMsg, draft: v.draft, appliedDraft, opened, hasSim: !!p.sim, voice: outcome?.kind ?? null })

  // An approved answer is spoken once (browser voice; the engine's ElevenLabs voice only if it has a key). Never anything else.
  const spokenRef = useRef<VoiceOutcome | null>(null)
  useEffect(() => {
    if (outcome?.kind !== 'answer' || spokenRef.current === outcome) return
    spokenRef.current = outcome
    void speakSentence(outcome.say)
  }, [outcome])
  useEffect(() => () => stopSpeaking(), [])

  // Kelvin's sentence for the result on screen: engine-written, then /guard + number check (else held: nothing new).
  const replyKey = sheet === 'result' ? p.sim : null
  useEffect(() => {
    if (!replyKey) return
    const st = planStore.get()
    const question = st.draft?.transcript
    if (st.source === 'optimized' && st.previous)
      void kelvin.request({ key: replyKey, intent: 'optimize', plan: st.previous.plan, preset: st.preset ?? 'max_load', question })
    else void kelvin.request({ key: replyKey, intent: 'plan_summary', plan: st.plan, question })
  }, [replyKey])
  const kelvinSay = reply.status === 'shown' && reply.key === p.sim ? reply.say : null

  const startRecording = () => {
    stopSpeaking()
    setOpened(null)
    setFlash(false)
    planStore.dismissError()
    v.start()
  }

  const close = () => {
    stopSpeaking()
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
    // The result sheet is for a plan the coach made (voice, edit, optimize); the engine's demo plan opens typing.
    if (p.sim && p.source !== 'fixture') setOpened((o) => (o === 'result' ? null : 'result'))
    else setOpened((o) => (o === 'typing' ? null : 'typing'))
  }

  const busyLabel =
    v.state === 'processing'
      ? ['Thinking', AI_NAME]
      : p.phase === 'optimizing'
        ? ['Optimizing', AI_NAME]
        : ['Modeling', `${roster.athletes.length} athletes`]

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
                    say={kelvinSay}
                    onSeePlayers={() => {
                      close()
                      onSeePlayers()
                    }}
                    onType={() => openTyping(p.draft?.transcript ?? '')}
                    onDone={close}
                  />
                )}
                {sheet === 'answer' && outcome && (outcome.kind === 'answer' || outcome.kind === 'held') && (
                  <Answer
                    outcome={outcome}
                    onAgain={startRecording}
                    onSay={() => outcome.kind === 'answer' && void speakSentence(outcome.say)}
                    onType={() => openTyping()}
                    onDone={close}
                  />
                )}
                {sheet === 'choose' && outcome?.kind === 'choose' && (
                  <Choose outcome={outcome} onPick={(o) => void v.choose(o)} onRedo={startRecording} onType={() => openTyping(outcome.transcript)} />
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
                    <div className="eyebrow">Ask a question or type today's practice</div>
                    <textarea
                      autoFocus
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitTyped()
                      }}
                      placeholder="What if we cut the gassers?  ·  10 min warm-up in helmets, 20 min individual in full pads, water break, 25 min team period…"
                      rows={4}
                    />
                    <div className="dock__actions">
                      <button className="btn btn--ink pressable" onClick={submitTyped} disabled={!text.trim()}>
                        Send
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
    // Gemini's change sentence only when it carries no number; numbers on screen are the engine's or the plan's.
    const first = p.draft?.edited ? p.draft.changes?.[0] : null
    const change = first && !hasDigits(first) ? first : null
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
      {draft.unclear.filter((u) => !hasDigits(u)).length > 0 && (
        <ul className="review__notes">
          {draft.unclear.filter((u) => !hasDigits(u)).map((u) => (
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

/** The AI's draft, for the coach to check before anything runs (the engine runs only after Confirm). */
function Confirm({ draft, onConfirm, onRedo, onType }: { draft: PlanDraft; onConfirm: () => void; onRedo: () => void; onType: () => void }) {
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
          Confirm
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
  // Gemini's notes are shown only when they carry no number (the drill list above shows every duration).
  const notes = { unclear: draft.unclear.filter((u) => !hasDigits(u)), assumptions: draft.assumptions.filter((a) => !hasDigits(a)) }
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
      {(notes.unclear.length > 0 || notes.assumptions.length > 0) && (
        <ul className="review__notes">
          {notes.unclear.map((u) => (
            <li key={u} className="is-unclear">
              <strong>Needs input</strong> {u}
            </li>
          ))}
          {notes.assumptions.slice(0, 3).map((a) => (
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
  say,
  onSeePlayers,
  onType,
  onDone,
}: {
  p: PlanState
  /** Kelvin's approved, engine-written sentence (null while loading, or when held). */
  say: string | null
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
  const name = (id: string) => roster.name(id)
  const optimizing = p.phase === 'optimizing'
  const edits = (p.draft?.changes ?? []).filter((c) => !hasDigits(c))
  const canOptimize = p.source !== 'optimized' && (over > 0 || near > 0 || sim.fhsaa_violations.length > 0)

  return (
    <div className="result">
      <div className="review__head">
        <div className="eyebrow">{p.source === 'optimized' ? 'Optimized plan' : 'Your plan'} · {AI_NAME}</div>
        <span className="review__label">{sim.labels[0]}</span>
      </div>

      <div className={`result__big ${over ? 'is-over' : 'is-clear'}`}>
        <span className="display-lg">
          <NumberTicker value={over} />
        </span>
        <span className="result__big-text">
          {over === 1 ? 'athlete' : 'athletes'} forecast over {fmtLimit(limit)}°
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
      {p.draft?.edited && edits.length > 0 && p.source === 'voice' && (
        <ul className="result__edits">
          {edits.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      {say && <p className="result__changes">{say}</p>}
      {p.opt && (
        <p className="faint num result__kept">
          Kept {p.opt.load_kept_pct}% of training load · {p.opt.changes.length} changes
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

/** The engine's sentence for a question (already guarded and number-checked), or the fixed message when the checks held it. */
function Answer({
  outcome,
  onAgain,
  onSay,
  onType,
  onDone,
}: {
  outcome: Extract<VoiceOutcome, { kind: 'answer' | 'held' }>
  onAgain: () => void
  onSay: () => void
  onType: () => void
  onDone: () => void
}) {
  const answered = outcome.kind === 'answer'
  const prov = answered ? provenanceLabels(outcome.labels) : []
  return (
    <div className="result">
      <div className="review__head">
        <div className="eyebrow">{answered ? `${AI_NAME} · answer` : `${AI_NAME} · held`}</div>
        <span className="review__label">{answered ? (outcome.labels[0] ?? 'estimate — planning only') : 'not shown'}</span>
      </div>
      {outcome.transcript && (
        <blockquote className="review__quote">
          <span className="eyebrow">{AI_NAME} heard</span> “{outcome.transcript}”
        </blockquote>
      )}
      <p className="result__changes">{answered ? outcome.say : HELD_MESSAGE}</p>
      {prov.length > 0 && <p className="faint result__kept">{prov.join(' · ')}</p>}
      <div className="dock__actions">
        <button className="btn btn--ink pressable" onClick={onAgain}>
          Ask another
        </button>
        {answered && speechAvailable() && (
          <button className="btn btn--quiet pressable" onClick={onSay}>
            Say it again
          </button>
        )}
        <button className="btn btn--quiet pressable" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="result__quiet">
        <button className="linkbtn" onClick={onType}>
          Type a question
        </button>
      </div>
    </div>
  )
}

/** "Did you mean …?": the decision layer was not sure; two options, nothing runs until one is tapped. */
function Choose({
  outcome,
  onPick,
  onRedo,
  onType,
}: {
  outcome: Extract<VoiceOutcome, { kind: 'choose' }>
  onPick: (o: Extract<VoiceOutcome, { kind: 'choose' }>['options'][number]) => void
  onRedo: () => void
  onType: () => void
}) {
  const what = outcome.asking === 'athlete' ? 'Which athlete?' : outcome.asking === 'drill' ? 'Which drill?' : 'Did you mean…?'
  return (
    <div className="review">
      <div className="review__head">
        <div className="eyebrow">{what}</div>
        <span className="review__label">{AI_NAME} wasn’t sure</span>
      </div>
      {outcome.transcript && <blockquote className="review__quote">“{outcome.transcript}”</blockquote>}
      <div className="dock__actions">
        {outcome.options.map((o, i) => (
          <button key={o.label} className={`btn ${i === 0 ? 'btn--ink' : 'btn--quiet'} pressable`} onClick={() => onPick(o)}>
            {o.label}
          </button>
        ))}
        <button className="btn btn--quiet pressable" onClick={onRedo}>
          Neither — try again
        </button>
        <button className="btn btn--quiet pressable" onClick={onType}>
          Edit as text
        </button>
      </div>
    </div>
  )
}

function ErrorView({ message, onRetry, onType }: { message: string; onRetry: () => void; onType: () => void }) {
  const friendly =
    message === NO_RECOGNIZER
      ? 'This browser has no speech recognition (try Chrome, Edge or Safari) and the engine has no offline Whisper model. Type your question or plan instead.'
      : /permission|NotAllowed/i.test(message)
        ? 'Microphone access was blocked. Allow it in the browser, or type it instead.'
        : /Failed to fetch|NetworkError|Load failed|reach the engine|ECONNREFUSED|HTTP 50[02]: ?$|^Internal Server Error$/i.test(message)
          ? 'Can’t reach the HeatTwin engine. Start it from the repo root with `make dev` (engine on port 8010), then try again.'
          : /timed out|took too long|TimeoutError/i.test(message)
            ? 'That took too long — the engine didn’t answer within a minute. Try again.'
            : message
  return (
    <div className="dock__error">
      <div className="eyebrow">Couldn’t do that</div>
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
