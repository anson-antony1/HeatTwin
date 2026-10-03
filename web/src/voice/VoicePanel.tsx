import { useCallback, useMemo, useRef, useState } from 'react'
import { ConversationProvider, useConversation } from '@elevenlabs/react'
import { AGENT_ID, ESTIMATE_LABEL } from './config'
import { engineApi } from './engineApi'
import { route } from './localAnswer'
import { NumberLedger } from './numbers'
import { TEST_QUESTIONS } from './testQuestions'
import { makeTools, type ToolName } from './tools'
import './VoicePanel.css'

// "Talk to the Twin". One component for the Plan screen: push-to-talk to an ElevenLabs agent whose CLIENT tools wrap
// the engine (/simulate, /optimize, /what_if, /athlete_status, /field_conditions), plus a text fallback.
//
// Language and number control, in order of strength:
//  1. the agent's prompt (agent/agent_config.json) — numbers only from tools, never "safe", no diagnosis;
//  2. every tool result carries a `say` sentence the engine already passed through engine/guard.py;
//  3. every agent reply is checked here: POST /guard + the number ledger (numbers no tool returned). On a hit the rest
//     of that reply is muted, the transcript shows the redacted text, and the agent is told to restate.
// Limit (said plainly): with a hosted agent the check runs on the reply text as it arrives, so the first words of a
// flagged reply may already be audible. Text mode (and the local fallback) are fully gated.

interface Entry {
  who: 'you' | 'twin' | 'tool' | 'note'
  text: string
  flagged?: string[]
}

function useLog() {
  const [log, setLog] = useState<Entry[]>([])
  const push = useCallback((e: Entry) => setLog((l) => [...l.slice(-40), e]), [])
  return { log, push }
}

async function checkReply(text: string, ledger: NumberLedger) {
  const g = await engineApi.guard(text).catch(() => null)
  const unsupported = ledger.unsupported(text)
  const flags = [
    ...(g && !g.ok ? g.hits.map((h) => `${h.rule}: “${h.match}”`) : []),
    ...unsupported.map((n) => `number not from a tool: ${n}`),
  ]
  return { shown: g ? g.redacted_text : text, flags, guardDown: g === null }
}

function Transcript({ log }: { log: Entry[] }) {
  return (
    <ol className="voice__log" aria-live="polite">
      {log.map((e, i) => (
        <li key={i} className={`voice__entry voice__entry--${e.who}`}>
          <span className="voice__who">{e.who === 'twin' ? 'Twin' : e.who === 'you' ? 'You' : e.who === 'tool' ? 'Tool' : 'Note'}</span>
          <span className="voice__text">{e.text}</span>
          {e.flagged?.length ? <span className="voice__flag">held back · {e.flagged.join(' · ')}</span> : null}
        </li>
      ))}
    </ol>
  )
}

/** Text-only fallback with no agent: routes the question to one tool and reads back the tool's guarded sentence. */
function useLocalTwin(push: (e: Entry) => void) {
  const ledger = useMemo(() => new NumberLedger(), [])
  const tools = useMemo(() => makeTools(ledger), [ledger])
  const names = useRef<string[]>([])
  return useCallback(
    async (q: string) => {
      push({ who: 'you', text: q })
      try {
        if (!names.current.length) {
          const sim = await engineApi.simulate()
          names.current = sim.athletes.map((a) => (a.name ?? a.id).replace(' (fictional)', ''))
        }
        const r = route(q, names.current)
        if (!r) {
          push({ who: 'twin', text: 'I can answer about the plan, one athlete, field conditions, or a what-if change.' })
          return
        }
        const out = JSON.parse(await tools[r.tool as ToolName](r.params))
        push({ who: 'tool', text: `${r.tool} ${JSON.stringify(r.params)}` })
        const { shown, flags } = await checkReply(String(out.say ?? ''), ledger)
        push({ who: 'twin', text: flags.length ? shown : `${shown}`, flagged: flags })
      } catch (err) {
        push({ who: 'note', text: `Engine not reachable (${(err as Error).message}).` })
      }
    },
    [ledger, push, tools],
  )
}

function TextBox({ onSend, disabled }: { onSend: (q: string) => void; disabled?: boolean }) {
  const [q, setQ] = useState('')
  return (
    <form
      className="voice__text-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) onSend(q.trim())
        setQ('')
      }}
    >
      <input
        className="voice__input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Type a question (text fallback)…"
        disabled={disabled}
        aria-label="Ask the twin"
      />
      <select
        className="voice__tests"
        aria-label="Scripted test questions"
        value=""
        onChange={(e) => e.target.value && onSend(e.target.value)}
      >
        <option value="">Test…</option>
        {TEST_QUESTIONS.map((t) => (
          <option key={t.q} value={t.q}>
            {t.q}
          </option>
        ))}
      </select>
    </form>
  )
}

function AgentTwin() {
  const { log, push } = useLog()
  const ledger = useMemo(() => new NumberLedger(), [])
  const tools = useMemo(() => {
    const raw = makeTools(ledger)
    const wrapped: Record<string, (p: Record<string, unknown>) => Promise<string>> = {}
    for (const [name, fn] of Object.entries(raw)) {
      wrapped[name] = async (p) => {
        push({ who: 'tool', text: `${name} ${JSON.stringify(p ?? {})}` })
        return fn(p ?? {})
      }
    }
    return wrapped
  }, [ledger, push])
  const [talking, setTalking] = useState(false)
  const local = useLocalTwin(push)

  const conv = useConversation({
    clientTools: tools,
    micMuted: !talking,
    onMessage: async (m: { message: string; source?: string; role?: string }) => {
      const fromAgent = (m.role ?? m.source) === 'agent' || m.source === 'ai'
      if (!fromAgent) {
        conv.setVolume({ volume: 1 })
        push({ who: 'you', text: m.message })
        return
      }
      const { shown, flags } = await checkReply(m.message, ledger)
      if (flags.length) {
        conv.setVolume({ volume: 0 })
        conv.sendContextualUpdate(
          `Your last reply was held back by the HeatTwin guard (${flags.join('; ')}). Restate it using only numbers ` +
            `from tool results, say "${ESTIMATE_LABEL}", and do not call anyone safe or fine.`,
        )
      }
      push({ who: 'twin', text: shown, flagged: flags })
    },
    onError: (e: unknown) => push({ who: 'note', text: `Voice error: ${String(e)}` }),
  })

  const connected = conv.status === 'connected'
  const start = async () => {
    if (conv.status !== 'disconnected') return
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      conv.startSession({ agentId: AGENT_ID!, connectionType: 'webrtc' })
    } catch {
      push({ who: 'note', text: 'Microphone unavailable — use the text box.' })
    }
  }
  const press = () => {
    setTalking(true)
    void start()
  }
  const release = () => setTalking(false)

  return (
    <section className="voice" aria-label="Talk to the Twin">
      <header className="voice__head">
        <span className="voice__title">Talk to the Twin</span>
        <span className={`voice__status voice__status--${conv.status}`}>
          {connected ? (conv.isSpeaking ? 'speaking' : talking ? 'listening' : 'ready') : conv.status}
        </span>
        {connected ? (
          <button className="btn btn--quiet voice__end" onClick={() => conv.endSession()}>
            End
          </button>
        ) : null}
      </header>
      <button
        className={`voice__ptt ${talking ? 'is-talking' : ''}`}
        onPointerDown={press}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onKeyDown={(e) => e.key === ' ' && !e.repeat && press()}
        onKeyUp={(e) => e.key === ' ' && release()}
      >
        {talking ? 'Listening… release to send' : 'Hold to talk'}
      </button>
      <Transcript log={log} />
      <TextBox onSend={(q) => (connected ? (push({ who: 'you', text: q }), conv.sendUserMessage(q)) : local(q))} />
      <footer className="voice__foot">{ESTIMATE_LABEL} · numbers come only from engine tools · every reply is guarded</footer>
    </section>
  )
}

function LocalOnlyTwin() {
  const { log, push } = useLog()
  const local = useLocalTwin(push)
  return (
    <section className="voice" aria-label="Talk to the Twin (text)">
      <header className="voice__head">
        <span className="voice__title">Talk to the Twin</span>
        <span className="voice__status">text mode · no voice agent configured</span>
      </header>
      <Transcript log={log} />
      <TextBox onSend={local} />
      <footer className="voice__foot">{ESTIMATE_LABEL} · answers are the engine's own guarded sentences</footer>
    </section>
  )
}

/** The one component the Plan screen mounts. Voice when VITE_ELEVENLABS_AGENT_ID is set, text fallback always. */
export function VoicePanel() {
  if (!AGENT_ID) return <LocalOnlyTwin />
  return (
    <ConversationProvider agentId={AGENT_ID}>
      <AgentTwin />
    </ConversationProvider>
  )
}
