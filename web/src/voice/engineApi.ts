import type { ContractGear, ContractIntensity, PracticePlan } from '../data/llmPlan'
import { ENGINE_URL } from './config'

// Typed client for the voice Q&A endpoints (CONTRACTS.md v1.3):
//   POST /voice/intent  {text | audio_b64 + mime_type, plan?, roster?} → VoiceIntent   (Gemini: transcript + intent + slots only)
//   POST /voice/answer  {intent, slots, plan?, roster?, settings?}     → VoiceAnswer   (?demo=1; engine runs the tool, writes `say`)
//   POST /voice/tts     {text}                                         → audio/mpeg    (422 guard hit, 503 no key / offline)
//   POST /guard         {text}                                         → GuardResult
// Every call takes an injectable fetch so tests run with no network.

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
}

/** status 0 = the engine could not be reached (network error, CORS, timeout). */
export class VoiceApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'VoiceApiError'
    this.status = status
  }
}

export const statusOf = (e: unknown): number => (e instanceof VoiceApiError ? e.status : 0)

const TIMEOUT_MS = 60_000

async function send(fetchImpl: typeof fetch, base: string, path: string, body: unknown): Promise<Response> {
  let r: Response
  try {
    r = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    })
  } catch (e) {
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
  return r
}

async function json<T>(r: Response, path: string): Promise<T> {
  try {
    return (await r.json()) as T
  } catch {
    throw new VoiceApiError(r.status, `${path} → response was not JSON`)
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
    async intent(req) {
      return json<VoiceIntent>(await send(fetchImpl, base, '/voice/intent', req), '/voice/intent')
    },
    async answer(req) {
      return json<VoiceAnswer>(await send(fetchImpl, base, '/voice/answer?demo=1', req), '/voice/answer')
    },
    async guard(text) {
      return json<GuardResult>(await send(fetchImpl, base, '/guard', { text }), '/guard')
    },
    async tts(text) {
      const r = await send(fetchImpl, base, '/voice/tts', { text })
      const type = r.headers.get('content-type') ?? ''
      if (!type.startsWith('audio/')) throw new VoiceApiError(r.status, `/voice/tts → expected audio, got ${type || 'no type'}`)
      return r.blob()
    },
  }
}

export const voiceApi = createVoiceApi()
