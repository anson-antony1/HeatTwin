import type { ContractGear, ContractIntensity, PracticePlan } from '../data/llmPlan'
import { ENGINE_URL } from './config'

// Typed client for the voice Q&A endpoints (CONTRACTS.md v1.3, + v1.4 `question`):
//   POST /voice/intent  {text | audio_b64 + mime_type, plan?, roster?} → VoiceIntent   (Gemini: transcript + intent + slots only)
//   POST /voice/answer  {intent, slots, plan?, question?}              → VoiceAnswer   (?demo=1; engine runs the tool, writes `say`)
//   POST /voice/tts     {text}                                         → audio/mpeg    (422 guard hit, 503 no key / offline)
//   POST /guard         {text}                                         → GuardResult
// Every call takes an injectable fetch so tests run with no network, and gives up after TIMEOUT_MS (20 s; 10 s for
// TTS) with a timed-out status-0 VoiceApiError, which the pipeline treats like an unreachable engine.

export type VoiceIntentName = 'plan_summary' | 'optimize' | 'what_if' | 'athlete_status' | 'field_conditions' | 'unknown'

export const VOICE_INTENTS: readonly VoiceIntentName[] = [
  'plan_summary',
  'optimize',
  'what_if',
  'athlete_status',
  'field_conditions',
  'unknown',
]

export type VoiceChange = 'gear' | 'duration' | 'shade' | 'intensity' | 'remove' | 'add_break' | 'move'

export interface VoiceSlots {
  athlete_id?: string
  drill_id?: string
  change?: VoiceChange
  gear?: ContractGear
  /** Only when the coach said it. Omitted for add_break so the engine uses the FHSAA break length. */
  duration_min?: number
  intensity?: ContractIntensity
  shade?: boolean
  move_to?: number
  preset?: 'max_load' | 'fewest_changes'
}

export interface VoiceIntent {
  transcript: string
  intent: VoiceIntentName
  slots: VoiceSlots
  /** Names the engine could not match on the plan (asked back, not guessed). */
  unresolved: string[]
  labels: string[]
  model: string
}

export interface VoiceAnswer {
  intent: VoiceIntentName
  /** Engine-written, engine-guarded; the ONLY text shown or spoken (after the browser's own checks). */
  say: string
  /** Every number token in `say`, as written — the per-answer ledger. */
  numbers: string[]
  data: Record<string, unknown>
  labels: string[]
}

export interface GuardHit {
  rule: string
  match: string
  start: number
  end: number
}

export interface GuardResult {
  ok: boolean
  redacted_text: string
  hits: GuardHit[]
}

export type IntentRequest =
  | { text: string; plan?: PracticePlan }
  | { audio_b64: string; mime_type: 'audio/wav'; plan?: PracticePlan }

export interface AnswerRequest {
  intent: VoiceIntentName
  slots: VoiceSlots
  plan?: PracticePlan
  /**
   * v1.4: the coach's own words (typed text, or the transcript of what they said). When it asks whether someone is
   * "safe / fine / OK / cleared", the engine starts `say` with its boundary sentence — no clearance is given.
   */
  question?: string
}

/** status 0 = the engine could not be reached (network error, CORS) or did not answer in time (`timedOut`). */
export class VoiceApiError extends Error {
  status: number
  timedOut: boolean
  constructor(status: number, message: string, timedOut = false) {
    super(message)
    this.name = 'VoiceApiError'
    this.status = status
    this.timedOut = timedOut
  }
}

export const statusOf = (e: unknown): number => (e instanceof VoiceApiError ? e.status : 0)
export const timedOut = (e: unknown): boolean => e instanceof VoiceApiError && e.timedOut

/**
 * How long the browser waits for each call (request + body) before giving up and falling back as it does when the
 * engine is unreachable: typed questions go to the local router, speech to speechSynthesis, a guard that doesn't answer
 * holds the reply. Never the old 60 s hang on stage.
 */
// answer: the engine may run an optimizer search (the fewest-changes search steps its cap; ~90 s cold, instant once
// warmed with `make warm`), so it gets longer than the network-bound calls.
export const TIMEOUT_MS = { intent: 20_000, answer: 120_000, guard: 20_000, tts: 10_000 } as const

/** POST `body` and read the response with `read`, all within `timeoutMs`. */
async function call<T>(
  fetchImpl: typeof fetch,
  base: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  read: (r: Response) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const late = () => new VoiceApiError(0, `${path} took longer than ${timeoutMs / 1000} s`, true)
  try {
    let r: Response
    try {
      r = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
    } catch (e) {
      if (ctl.signal.aborted) throw late()
      throw new VoiceApiError(0, `Can't reach the engine (${base}): ${(e as Error).message}`)
    }
    if (!r.ok) {
      let detail = r.statusText
      try {
        const j = await r.json()
        detail = typeof j?.detail === 'string' ? j.detail : JSON.stringify(j?.detail ?? j)
      } catch {
        /* keep statusText */
      }
      throw new VoiceApiError(r.status, `${path} → HTTP ${r.status}${detail ? `: ${detail}` : ''}`)
    }
    try {
      return await read(r)
    } catch (e) {
      if (ctl.signal.aborted) throw late()
      throw e
    }
  } finally {
    clearTimeout(timer)
  }
}

function json<T>(path: string): (r: Response) => Promise<T> {
  return async (r) => {
    try {
      return (await r.json()) as T
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      throw new VoiceApiError(r.status, `${path} → response was not JSON`)
    }
  }
}

export interface VoiceApi {
  intent(req: IntentRequest): Promise<VoiceIntent>
  answer(req: AnswerRequest): Promise<VoiceAnswer>
  guard(text: string): Promise<GuardResult>
  /** Resolves to the audio/mpeg body. Rejects with VoiceApiError (422 = guard hit, 503 = no key / offline). */
  tts(text: string): Promise<Blob>
}

export function createVoiceApi(
  fetchImpl: typeof fetch = (...a: Parameters<typeof fetch>) => fetch(...a), // late-bound so tests can stub global fetch
  base: string = ENGINE_URL,
): VoiceApi {
  return {
    intent(req) {
      return call(fetchImpl, base, '/voice/intent', req, TIMEOUT_MS.intent, json<VoiceIntent>('/voice/intent'))
    },
    answer(req) {
      return call(fetchImpl, base, '/voice/answer?demo=1', req, TIMEOUT_MS.answer, json<VoiceAnswer>('/voice/answer'))
    },
    guard(text) {
      return call(fetchImpl, base, '/guard', { text }, TIMEOUT_MS.guard, json<GuardResult>('/guard'))
    },
    tts(text) {
      return call(fetchImpl, base, '/voice/tts', { text }, TIMEOUT_MS.tts, async (r) => {
        const type = r.headers.get('content-type') ?? ''
        if (!type.startsWith('audio/')) throw new VoiceApiError(r.status, `/voice/tts → expected audio, got ${type || 'no type'}`)
        return r.blob()
      })
    },
  }
}

export const voiceApi = createVoiceApi()
