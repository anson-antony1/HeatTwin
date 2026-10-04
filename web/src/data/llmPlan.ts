// Coach plan entry by text or voice → draft PracticePlan, via the engine's Gemini bridge
// (engine/llm_routes.py). The API key lives only on the engine (.env), never in the browser.
//
//   const draft = await parsePlanText('10 min warmup in helmets, 20 min individual in full pads…')
//   // or, from useVoicePlan(): await parsePlanAudio(wavBlob)
//   show draft.transcript, draft.plan.drills, draft.assumptions, draft.unclear → coach edits/confirms →
//   POST draft.plan to /simulate or /optimize (CONTRACTS.md PracticePlan, unchanged).

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

// ── CONTRACTS.md shapes (engine side) ──
export type ContractGear = 'none' | 'helmet' | 'helmet_shoulder_pads' | 'full_pads'
export type ContractIntensity = 'rest' | 'light' | 'moderate' | 'hard' | 'max'

export interface ContractDrill {
  id: string
  name: string
  duration_min: number
  intensity: ContractIntensity
  met_override?: number
  gear: ContractGear
  gear_by_athlete?: Record<string, ContractGear>
  shade: boolean
  is_break: boolean
  priority: 1 | 2 | 3
  movable: boolean
  participants?: string[]
}

export interface PracticePlan {
  id: string
  site: { name: string; lat: number; lon: number; surface: 'grass' | 'turf' }
  start: string
  drills: ContractDrill[]
}

export interface PlanDraft {
  plan: PracticePlan
  /** What the coach said (verbatim transcript for voice). Show it so the coach can spot mishearings. */
  transcript: string
  /** Every value the AI filled in that the coach didn't say. Show as "Check:" items. */
  assumptions: string[]
  /** Things the AI couldn't interpret (e.g. a drill with no duration — it is left out of plan.drills). */
  unclear: string[]
  total_min: number
  /** Always true: the coach must confirm before simulating. */
  needs_confirmation: true
  /** e.g. "parsed by AI from the coach's description — coach must confirm". Display it. */
  labels: string[]
  model: string
  /** Set when current_plan was sent: one sentence per change Gemini made. */
  changes?: string[]
  edited?: boolean
}

export interface PlanContext {
  /** PracticePlan.site; defaults to the engine's fixture site (Gainesville demo field). */
  site?: PracticePlan['site']
  /** YYYY-MM-DD the spoken start time applies to; defaults to the fixture date. */
  date?: string
  /** Full ISO start time; overrides any spoken start time. */
  start?: string
  /** The plan already in use: the coach's words edit it and keep everything else. */
  current_plan?: PracticePlan
}

export class PlanParseError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(`${ENGINE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Never leave the UI waiting on a dropped connection (engine's own Gemini timeout is 45 s).
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
  })
  if (!r.ok) {
    let msg = r.statusText
    try {
      const j = await r.json()
      msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
    } catch {
      /* keep statusText */
    }
    // 503 = no GEMINI_API_KEY on the engine, 502 = Gemini failed, 422 = bad input
    throw new PlanParseError(r.status, msg)
  }
  return r.json() as Promise<T>
}

export async function llmStatus(): Promise<{ configured: boolean; provider: string; model: string }> {
  const r = await fetch(`${ENGINE}/plan/llm_status`)
  return r.json()
}

export function parsePlanText(text: string, ctx: PlanContext = {}, signal?: AbortSignal): Promise<PlanDraft> {
  return post<PlanDraft>('/plan/parse', { text, ...ctx }, signal)
}

/** `wav` must be audio/wav (useVoicePlan produces it). Chrome's default webm recording is rejected by the engine. */
export async function parsePlanAudio(wav: Blob, ctx: PlanContext = {}, signal?: AbortSignal): Promise<PlanDraft> {
  const audio_b64 = await blobToBase64(wav)
  return post<PlanDraft>('/plan/parse_audio', { audio_b64, mime_type: wav.type || 'audio/wav', ...ctx }, signal)
}

async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(s)
}
