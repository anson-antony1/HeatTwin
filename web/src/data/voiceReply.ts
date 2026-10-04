import { useSyncExternalStore } from 'react'
import { guardText, voiceAnswer, type GuardResult, type OptimizePreset, type VoiceAnswer, type VoiceIntentName } from './engineApi'
import type { PracticePlan } from './llmPlan'

// Kelvin's sentences. Gemini only transcribes and structures (the plan draft);
// any sentence the dock shows with a number in it is written by the engine
// (POST /voice/answer?demo=1) and is shown only after it is APPROVED:
//   1. POST /guard {text: say} answers ok: true — unreachable or malformed → HELD (fail closed);
//   2. every number / clock time in `say` is in THIS answer's `numbers` (no rounding, sign kept).
// A held reply shows nothing new and is never spoken.

// ── per-answer number check ────────────────────────────────────────────────

/** Identical to engine/voice.py `_NUM` (CONTRACTS v1.3 VoiceAnswer.numbers). */
export const NUMBER_TOKEN = /\b\d{1,2}:\d{2}\b|-?\d+(?:\.\d+)?/g

interface NumberToken {
  text: string
  kind: 'number' | 'time'
  /** Numbers: the signed value as written. Times: minutes since midnight. */
  value: number
}

export function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = []
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const tok = m[0]
    if (tok.includes(':')) {
      const [h, mm] = tok.split(':')
      out.push({ text: tok, kind: 'time', value: Number(h) * 60 + Number(mm) })
    } else out.push({ text: tok, kind: 'number', value: Number(tok) })
  }
  return out
}

/** Does every number/time in `say` appear in this answer's `numbers`? A missing or malformed `numbers` fails closed. */
export function checkNumbers(say: string, numbers: unknown): { ok: boolean; missing: string[] } {
  const entries = Array.isArray(numbers) ? numbers.filter((n): n is string | number => typeof n === 'string' || typeof n === 'number') : []
  const values = new Set<number>()
  const times = new Set<number>()
  for (const e of entries) for (const t of numberTokens(String(e))) (t.kind === 'time' ? times : values).add(t.value)
  const missing = numberTokens(say)
    .filter((t) => !(t.kind === 'time' ? times.has(t.value) : values.has(t.value)))
    .map((t) => t.text)
  return { ok: missing.length === 0, missing }
}

/** A Gemini-written sentence may be shown only when it carries no number (numbers on screen are the engine's). */
export function hasDigits(text: string): boolean {
  return /\d/.test(text)
}

// ── approval ───────────────────────────────────────────────────────────────

export type Approval = { ok: true; say: string; labels: string[] } | { ok: false; reason: string }

/** Guard + per-answer number check. Reasons never quote `say`. */
export async function approveAnswer(answer: VoiceAnswer, guard: (text: string) => Promise<GuardResult> = guardText): Promise<Approval> {
  const say = typeof answer?.say === 'string' ? answer.say.trim() : ''
  if (!say) return { ok: false, reason: 'the engine returned no sentence' }
  const reasons: string[] = []
  if (say.includes('[removed:')) reasons.push("the engine's guard removed part of the sentence")
  try {
    const g = await guard(say)
    if (!g || typeof g.ok !== 'boolean') reasons.push('the language guard gave no verdict')
    else if (!g.ok) {
      // v1.7: say which layer blocked — "guard.py" (rules) and/or "assist" (the decision layer's embedding classifier)
      const rules = [...new Set([...(g.hits ?? []), ...(g.assist?.hits ?? [])].map((h) => h.rule))].join(', ') || 'rule'
      const layers = g.blocked_by?.length ? ` by ${g.blocked_by.join(' + ')}` : ''
      reasons.push(`the language guard flagged it${layers} (${rules})`)
    }
  } catch {
    reasons.push('the language guard could not be reached')
  }
  const n = checkNumbers(say, answer.numbers)
  if (!n.ok) reasons.push(`${n.missing.length} number(s) in it are not in this answer's engine numbers`)
  if (reasons.length) return { ok: false, reason: reasons.join('; ') }
  return { ok: true, say, labels: Array.isArray(answer.labels) ? answer.labels.filter((l) => typeof l === 'string') : [] }
}

// ── the reply the dock shows for a result ──────────────────────────────────

export interface KelvinReply {
  /** The engine result this reply belongs to (the dock shows it only while that result is on screen). */
  key: object | null
  status: 'idle' | 'loading' | 'shown' | 'held'
  say: string | null
  labels: string[]
  /** Why a reply was held (for the log; never shown with the sentence). */
  reason: string | null
}

const IDLE: KelvinReply = { key: null, status: 'idle', say: null, labels: [], reason: null }
let state: KelvinReply = IDLE
const listeners = new Set<() => void>()
let inflight: AbortController | null = null

function set(next: KelvinReply) {
  state = next
  listeners.forEach((fn) => fn())
}

export interface ReplyRequest {
  key: object
  intent: VoiceIntentName
  /** The plan the engine answers about (for `optimize`, the plan before optimization). */
  plan: PracticePlan
  /** The coach's words, so the engine can state its boundary first when they ask for clearance. */
  question?: string
  preset?: OptimizePreset
}

export interface ReplyDeps {
  answer: typeof voiceAnswer
  guard: (text: string) => Promise<GuardResult>
}

export const kelvin = {
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  get: () => state,

  /** Ask the engine for the sentence about `key` (once per result). */
  async request(req: ReplyRequest, deps: ReplyDeps = { answer: voiceAnswer, guard: guardText }): Promise<KelvinReply> {
    if (state.key === req.key && state.status !== 'idle') return state
    inflight?.abort()
    const ctl = new AbortController()
    inflight = ctl
    set({ ...IDLE, key: req.key, status: 'loading' })
    let next: KelvinReply
    try {
      const question = req.question?.trim()
      const answer = await deps.answer(
        { intent: req.intent, slots: req.preset ? { preset: req.preset } : {}, plan: req.plan, ...(question ? { question } : {}) },
        ctl.signal,
      )
      const ap = await approveAnswer(answer, deps.guard)
      next = ap.ok
        ? { key: req.key, status: 'shown', say: ap.say, labels: ap.labels, reason: null }
        : { key: req.key, status: 'held', say: null, labels: [], reason: ap.reason }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return state
      next = { key: req.key, status: 'held', say: null, labels: [], reason: `the engine could not answer: ${(e as Error).message}` }
    }
    if (inflight !== ctl) return state
    if (next.status === 'held') console.warn(`Kelvin reply held — ${next.reason}. Not shown or spoken.`)
    set(next)
    return next
  },

  reset() {
    inflight?.abort()
    set(IDLE)
  },
}

export function useKelvinReply(): KelvinReply {
  return useSyncExternalStore(kelvin.subscribe, kelvin.get)
}
