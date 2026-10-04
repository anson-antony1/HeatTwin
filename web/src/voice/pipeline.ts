import type { PracticePlan } from '../data/llmPlan'
import {
  statusOf,
  timedOut,
  TIMEOUT_MS,
  VOICE_INTENTS,
  type VoiceAnswer,
  type VoiceApi,
  type VoiceIntent,
  type VoiceIntentName,
  type VoiceSlots,
} from './engineApi'
import { routeLocal, type RosterName } from './localAnswer'
import { checkNumbers } from './numbers'

// One question, end to end (AUDIT fix list P0-5):
//
//   typed text ─┐                         ┌─ 503 / unreachable + typed → local router (localAnswer.ts)
//   mic → WAV ──┴→ POST /voice/intent ────┤
//                  (Gemini: transcript,   └─ 503 / unreachable + spoken → "type the question instead"
//                   intent, slots only)
//   → POST /voice/answer?demo=1  (the engine runs the tool and writes `say` + its `numbers`)
//   → APPROVE, before anything is shown or spoken:
//        1. POST /guard {text: say} must answer ok: true   (unreachable or malformed → HELD: fail closed)
//        2. every number/time in `say` is in THIS answer's `numbers`
//      either fails → HELD: "Held — <reason>. Not shown or spoken."  `say` is never displayed or spoken.
//   → speak the approved `say` only: POST /voice/tts → audio/mpeg; on 503 / any failure → speechSynthesis.
//      (422 = the engine's guard rejected it at TTS time → not spoken at all.)
//
// The plan sent is always the plan on screen; the engine resolves names against it.
// Nothing waits long: /voice/intent, /voice/answer and /guard give up after 20 s and /voice/tts after 10 s
// (engineApi.ts TIMEOUT_MS); a timeout falls back exactly like an unreachable engine (local router, held reply,
// speechSynthesis).

export const VOICE_NEEDS_ENGINE = "Voice needs the engine's Gemini key and network — type the question instead."

// ── approval ──

export interface ApprovedAnswer {
  ok: true
  say: string
  labels: string[]
}
export type Approval = ApprovedAnswer | { ok: false; reason: string }

/**
 * Guard + per-answer number check. Reasons never quote `say` (a held sentence, or an unbacked number in it, must not
 * reach the screen): they name the guard rule or count the numbers.
 */
export async function approveAnswer(answer: VoiceAnswer, api: Pick<VoiceApi, 'guard'>): Promise<Approval> {
  const say = typeof answer?.say === 'string' ? answer.say.trim() : ''
  if (!say) return { ok: false, reason: 'the engine returned no sentence' }
  const reasons: string[] = []
  if (say.includes('[removed:')) reasons.push("the engine's guard removed part of the sentence")
  try {
    const g = await api.guard(say)
    if (!g || typeof g.ok !== 'boolean') reasons.push('the language guard gave no verdict')
    else if (!g.ok) {
      const rules = [...new Set((g.hits ?? []).map((h) => h.rule))].join(', ') || 'unspecified rule'
      reasons.push(`the language guard flagged it (${rules})`)
    }
  } catch {
    reasons.push('the language guard could not be reached')
  }
  const n = checkNumbers(say, answer.numbers)
  if (!n.ok) {
    const k = n.missing.length
    reasons.push(`${k} number${k === 1 ? '' : 's'} in it ${k === 1 ? 'is' : 'are'} not in this answer's engine numbers`)
  }
  if (reasons.length) return { ok: false, reason: reasons.join('; ') }
  const labels = Array.isArray(answer.labels) ? answer.labels.filter((l): l is string => typeof l === 'string') : []
  return { ok: true, say, labels: [...new Set(labels)] }
}

// ── speech ──

export interface SpeechOut {
  /** POST /voice/tts → audio/mpeg. */
  tts: (text: string) => Promise<Blob>
  /** Start playing the audio; resolves once playback has started, rejects if it can't. */
  play: (audio: Blob) => Promise<void>
  /** window.speechSynthesis; null where the browser has none. */
  fallback: ((text: string) => void) | null
}

export type Spoken = 'tts' | 'browser' | 'not_spoken' | 'held_by_tts_guard'

/** Speak an APPROVED answer (the type only accepts the output of approveAnswer). */
export async function speakApproved(approved: ApprovedAnswer, out: SpeechOut): Promise<Spoken> {
  const text = approved.say
  try {
    await out.play(await out.tts(text))
    return 'tts'
  } catch (e) {
    if (statusOf(e) === 422) return 'held_by_tts_guard' // never route a guard-rejected text to another voice
    if (!out.fallback) return 'not_spoken'
    try {
      out.fallback(text)
      return 'browser'
    } catch {
      return 'not_spoken'
    }
  }
}

// ── one turn ──

export type TurnInput = { kind: 'text'; text: string } | { kind: 'audio'; audio_b64: string; mime_type: 'audio/wav' }

export interface TurnContext {
  /** The plan on screen (planStore.get().plan). */
  plan: PracticePlan
  /** Roster names, for the local router only (the engine resolves names itself). */
  roster: RosterName[]
}

export interface TurnDeps {
  api: VoiceApi
  /** null = replies are not spoken (muted). */
  speech: SpeechOut | null
}

export interface Turn {
  id: number
  source: 'voice' | 'text'
  phase: 'routing' | 'answering' | 'checking' | 'speaking' | 'done'
  /** What the coach typed, or the transcript of what they said. */
  you?: string
  tool?: {
    intent: VoiceIntentName
    slots: VoiceSlots
    unresolved: string[]
    router: 'gemini' | 'local'
    /** Why the local router was used. */
    why?: string
    model: string
  }
  /** Set only after approval. */
  answer?: { say: string; labels: string[] }
  /** Set instead of `answer` when the reply was held. */
  held?: string
  /** A notice from the app (no engine sentence), e.g. engine unreachable. */
  note?: string
  spoken?: Spoken
}

/** Intent statuses that mean "no intent service right now" (no key, engine down, older engine without the route). */
const INTENT_UNAVAILABLE = new Set([0, 404, 501, 502, 503, 504])

function isVoiceIntent(x: unknown): x is VoiceIntent {
  const v = x as VoiceIntent
  return !!v && typeof v === 'object' && VOICE_INTENTS.includes(v.intent)
}

let seq = 0

export async function runTurn(input: TurnInput, ctx: TurnContext, deps: TurnDeps, emit: (t: Turn) => void = () => {}): Promise<Turn> {
  let turn: Turn = {
    id: ++seq,
    source: input.kind === 'text' ? 'text' : 'voice',
    phase: 'routing',
    you: input.kind === 'text' ? input.text : undefined,
  }
  const update = (patch: Partial<Turn>) => {
    turn = { ...turn, ...patch }
    emit(turn)
    return turn
  }
  emit(turn)

  // 1) intent
  let vi: VoiceIntent
  let router: 'gemini' | 'local' = 'gemini'
  let why: string | undefined
  try {
    const raw = await deps.api.intent(
      input.kind === 'text' ? { text: input.text, plan: ctx.plan } : { audio_b64: input.audio_b64, mime_type: input.mime_type, plan: ctx.plan },
    )
    if (!isVoiceIntent(raw)) throw new Error('/voice/intent → not a VoiceIntent')
    vi = raw
  } catch (e) {
    const s = statusOf(e)
    if (input.kind === 'audio') {
      return update({ phase: 'done', note: INTENT_UNAVAILABLE.has(s) ? VOICE_NEEDS_ENGINE : `Couldn't use the recording (HTTP ${s}) — type the question instead.` })
    }
    vi = routeLocal(input.text, ctx.plan, ctx.roster)
    router = 'local'
    why = timedOut(e)
      ? `the intent service took longer than ${TIMEOUT_MS.intent / 1000} s`
      : s === 503
        ? 'no intent service on the engine (HTTP 503)'
        : s === 0
          ? 'engine unreachable'
          : `intent service failed (HTTP ${s})`
  }
  update({
    phase: 'answering',
    you: input.kind === 'text' ? input.text : vi.transcript || '(no words heard)',
    tool: { intent: vi.intent, slots: vi.slots ?? {}, unresolved: vi.unresolved ?? [], router, why, model: vi.model },
  })

  // 2) the engine answers
  let answer: VoiceAnswer
  try {
    // v1.4: the coach's words go too, so the engine can open with its boundary sentence when they ask for clearance.
    const question = (input.kind === 'text' ? input.text : vi.transcript)?.trim()
    answer = await deps.api.answer({ intent: vi.intent, slots: vi.slots ?? {}, plan: ctx.plan, ...(question ? { question } : {}) })
  } catch (e) {
    const s = statusOf(e)
    // Plain words only; the raw error (e.g. a proxy or read-timeout name) never reaches the panel.
    return update({
      phase: 'done',
      note: timedOut(e)
        ? `The engine didn't answer within ${TIMEOUT_MS.answer / 1000} s — no answer. Try again.`
        : s === 0
          ? "Can't reach the engine — no answer."
          : `The engine couldn't answer (HTTP ${s}). Try again.`,
    })
  }

  // 3) approve before anything is shown or spoken
  update({ phase: 'checking' })
  const ap = await approveAnswer(answer, deps.api)
  if (!ap.ok) return update({ phase: 'done', held: ap.reason })
  // 4) show, then speak, only the approved sentence
  if (!deps.speech) return update({ phase: 'done', answer: { say: ap.say, labels: ap.labels }, spoken: 'not_spoken' })
  update({ phase: 'speaking', answer: { say: ap.say, labels: ap.labels } })
  const spoken = await speakApproved(ap, deps.speech)
  return update({ phase: 'done', spoken })
}
