import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { planStore, usePlanState, type PlanState } from '../data/planStore'
import { AI_NAME } from '../lib/brand'
import { ESTIMATE_LABEL } from './config'
import { voiceApi } from './engineApi'
import type { RosterName } from './localAnswer'
import { runTurn, type Turn, type TurnInput } from './pipeline'
import { voiceRoster } from './roster'
import { browserSpeech, stopSpeaking } from './speech'
import { TEST_QUESTIONS } from './testQuestions'
import { usePushToTalk } from './usePushToTalk'
import './VoicePanel.css'

// "Ask Kelvin": voice / text Q&A about the plan on screen.
//   Gemini (on the engine) only turns the question into {intent, slots}; the engine runs the tool and writes the
//   sentence; this panel shows or speaks that sentence only after POST /guard says ok AND every number in it is in that
//   answer's own `numbers`. Anything else is HELD (see pipeline.ts). A guard outage holds the reply (fail closed).

const SOURCE_LABEL: Record<PlanState['source'], string> = {
  fixture: 'the demo plan (synthetic fixture)',
  voice: "the coach's confirmed plan",
  optimized: 'the optimized plan',
  edited: 'the edited plan',
}

const PHASE_TEXT: Record<Turn['phase'], string> = {
  routing: 'Understanding the question…',
  answering: 'Asking the engine…',
  checking: 'Checking the answer…',
  speaking: 'Speaking…',
  done: '',
}

let noteSeq = 0

function describeTool(tool: NonNullable<Turn['tool']>, plan: PlanState['plan'], roster: RosterName[]): string {
  const parts: string[] = [tool.intent]
  for (const [k, v] of Object.entries(tool.slots)) {
    if (v === undefined || v === null) continue
    let shown = `${k}=${String(v)}`
    if (k === 'drill_id') {
      const d = plan.drills.find((x) => x.id === v)
      if (d) shown += ` (${d.name})`
    }
    if (k === 'athlete_id') {
      const a = roster.find((x) => x.id === v)
      if (a) shown += ` (${a.name})`
    }
    parts.push(shown)
  }
  if (tool.unresolved.length) parts.push(`couldn't match: ${tool.unresolved.join('; ')}`)
  parts.push(tool.router === 'local' ? `local router — ${tool.why ?? 'no intent service'}` : `routed by ${tool.model || 'Gemini'}`)
  return parts.join(' · ')
}

function Row({ who, kind, children }: { who: string; kind: string; children: ReactNode }) {
  return (
    <div className={`voice__row voice__row--${kind}`}>
      <span className="voice__who">{who}</span>
      <div className="voice__text">{children}</div>
    </div>
  )
}

function TurnView({ t, plan, roster }: { t: Turn; plan: PlanState['plan']; roster: RosterName[] }) {
  return (
    <li className="voice__turn">
      {t.you != null ? (
        <Row who="You" kind="you">
          {t.source === 'voice' ? <q>{t.you}</q> : t.you}
        </Row>
      ) : null}
      {t.tool ? (
        <Row who="Tool" kind="tool">
          {describeTool(t.tool, plan, roster)}
        </Row>
      ) : null}
      {t.answer ? (
        <Row who={AI_NAME} kind="kelvin">
          <p className="voice__say">{t.answer.say}</p>
          {t.answer.labels.length ? (
            <ul className="voice__chips" aria-label="Labels">
              {t.answer.labels.map((l) => (
                <li key={l} className="voice__chip">
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          {t.spoken === 'browser' ? <span className="voice__aside">spoken with the browser voice</span> : null}
          {t.spoken === 'held_by_tts_guard' ? <span className="voice__aside">not spoken — the engine's speech guard refused it</span> : null}
        </Row>
      ) : null}
      {t.held ? (
        <Row who={AI_NAME} kind="held">
          Held — {t.held}. Not shown or spoken.
        </Row>
      ) : null}
      {t.note ? (
        <Row who="Note" kind="note">
          {t.note}
        </Row>
      ) : null}
      {t.phase !== 'done' ? (
        <Row who="" kind="pending">
          {PHASE_TEXT[t.phase]}
        </Row>
      ) : null}
    </li>
  )
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(el.tagName))

/** The panel the Plan screen mounts. Sends the plan on screen with every question. */
export function VoicePanel() {
  const planState = usePlanState()
  const [turns, setTurns] = useState<Turn[]>([])
  const [speak, setSpeak] = useState(true)
  const [inflight, setInflight] = useState(0)
  const [q, setQ] = useState('')
  const speakRef = useRef(speak) // read when a turn starts; kept in step by the checkbox handler
  const logRef = useRef<HTMLOListElement>(null)

  const upsert = useCallback((t: Turn) => {
    setTurns((ts) => {
      const i = ts.findIndex((x) => x.id === t.id)
      if (i < 0) return [...ts.slice(-19), t]
      const next = ts.slice()
      next[i] = t
      return next
    })
  }, [])

  const notice = useCallback((text: string) => upsert({ id: -++noteSeq, source: 'voice', phase: 'done', note: text }), [upsert])

  const ask = useCallback(
    async (input: TurnInput) => {
      stopSpeaking()
      setInflight((n) => n + 1)
      const s = planStore.get() // the plan on screen right now
      try {
        await runTurn(input, { plan: s.plan, roster: voiceRoster(s) }, { api: voiceApi, speech: speakRef.current ? browserSpeech : null }, upsert)
      } catch (e) {
        notice(`Something went wrong (${(e as Error).message}).`)
      } finally {
        setInflight((n) => n - 1)
      }
    },
    [notice, upsert],
  )

  const ptt = usePushToTalk((audio_b64) => void ask({ kind: 'audio', audio_b64, mime_type: 'audio/wav' }), notice)
  const { start, stop } = ptt

  // Hold Space anywhere outside a text field to talk.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return
      e.preventDefault()
      void start()
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (!isTyping(e.target)) e.preventDefault()
      stop()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [start, stop])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns])

  useEffect(() => () => stopSpeaking(), [])

  const send = (text: string) => {
    const t = text.trim()
    if (t) void ask({ kind: 'text', text: t })
  }

  const roster = voiceRoster(planState)
  const status =
    ptt.state === 'recording'
      ? 'listening — release to send'
      : ptt.state === 'converting'
        ? 'reading the recording…'
        : ptt.state === 'starting'
          ? 'opening the mic…'
          : inflight > 0
            ? 'working…'
            : 'ready'

  return (
    <section className="voice" aria-label={`Ask ${AI_NAME}`}>
      <header className="voice__head">
        <span className="voice__title">Ask {AI_NAME}</span>
        <span className={`voice__status${ptt.recording ? ' is-live' : ''}`} aria-live="polite">
          {status}
        </span>
        <label className="voice__speak">
          <input
            type="checkbox"
            checked={speak}
            onChange={(e) => {
              const on = e.target.checked
              speakRef.current = on
              setSpeak(on)
              if (!on) stopSpeaking()
            }}
          />
          Speak replies
        </label>
      </header>
      <p className="voice__plan">Questions are about {SOURCE_LABEL[planState.source]} on screen.</p>

      <button
        type="button"
        className={`voice__ptt${ptt.recording ? ' is-recording' : ''}`}
        aria-pressed={ptt.recording}
        onPointerDown={(e) => {
          e.preventDefault()
          void start()
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onKeyDown={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          if (!e.repeat) void start()
        }}
        onKeyUp={(e) => {
          if (e.key !== ' ' && e.key !== 'Enter') return
          e.preventDefault()
          stop()
        }}
      >
        {ptt.recording ? 'Listening… release to send' : 'Hold to talk (or hold Space)'}
      </button>

      <ol className="voice__log" ref={logRef} aria-live="polite">
        {turns.map((t) => (
          <TurnView key={t.id} t={t} plan={planState.plan} roster={roster} />
        ))}
      </ol>

      <form
        className="voice__form"
        onSubmit={(e) => {
          e.preventDefault()
          send(q)
          setQ('')
        }}
      >
        <input
          className="voice__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Type a question for ${AI_NAME}…`}
          aria-label={`Ask ${AI_NAME}`}
        />
        <button type="submit" className="voice__send" disabled={!q.trim()}>
          Ask
        </button>
        <select className="voice__tests" aria-label="Scripted test questions" value="" onChange={(e) => send(e.target.value)}>
          <option value="">Test…</option>
          {TEST_QUESTIONS.map((t) => (
            <option key={t.q} value={t.q}>
              {t.q}
            </option>
          ))}
        </select>
      </form>
      <footer className="voice__foot">
        {ESTIMATE_LABEL} · numbers come only from the engine · each reply passes the language guard and a per-answer number
        check before it is shown or spoken
      </footer>
    </section>
  )
}
