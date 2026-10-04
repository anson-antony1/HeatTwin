import {
  guardText,
  voiceAnswer,
  voiceDecide,
  type DecideChoices,
  type DecideResult,
  type DidYouMeanOption,
  type GuardResult,
  type VoiceAnswer,
  type VoiceAnswerRequest,
  type VoiceIntentName,
} from './engineApi'
import { llmStatus, parsePlanLocal, parsePlanText, type PlanContext, type PlanDraft, type PracticePlan } from './llmPlan'
import { approveAnswer } from './voiceReply'

// The voice path, free of any paid API (Gemini is optional and off by default):
//
//   transcript → POST /voice/decide (engine/decide.py: typed choices, abstains when unsure)
//     ├─ unsure            → "Did you mean …?" with the two most probable options (kind: 'choose'); a tap re-asks with `choices`
//     ├─ plan entry / edit → a DRAFT plan for the Confirm sheet: the engine's local parser, or Gemini when the engine has a key
//     └─ a question        → POST /voice/answer (the ENGINE writes the sentence) → /guard (rules + assist) + number check →
//                            kind: 'answer' (shown and spoken), or 'held' (the sentence is never shown or spoken)
//
// Numbers on screen are always the engine's; this module never composes a sentence about heat.

export type Choices = DecideChoices

export type VoiceOutcome =
  | { kind: 'draft'; transcript: string; draft: PlanDraft }
  | { kind: 'answer'; transcript: string; intent: VoiceIntentName; say: string; labels: string[]; backend: string }
  | { kind: 'choose'; transcript: string; asking: 'intent' | 'athlete' | 'drill'; options: DidYouMeanOption[]; choices: Choices }
  | { kind: 'held'; transcript: string; reason: string }

export interface FlowDeps {
  decide: (req: { text: string; plan?: PracticePlan; choices?: Choices }, signal?: AbortSignal) => Promise<DecideResult>
  answer: (req: VoiceAnswerRequest, signal?: AbortSignal) => Promise<VoiceAnswer>
  guard: (text: string) => Promise<GuardResult>
  parsePlan: (text: string, ctx: PlanContext, signal?: AbortSignal) => Promise<PlanDraft>
  /** When this says yes (Gemini is configured), Gemini reads every utterance first — see runVoiceFlow. */
  geminiFirst?: () => Promise<boolean>
}

let geminiCache: { at: number; configured: boolean } | null = null

/** Is Gemini usable? Only when the engine says so (a key AND paid APIs enabled); off by default. Cached for 30 s. */
export async function geminiConfigured(): Promise<boolean> {
  if (!geminiCache || Date.now() - geminiCache.at > 30_000) {
    let configured = false
    try {
      configured = (await llmStatus()).configured
    } catch {
      configured = false
    }
    geminiCache = { at: Date.now(), configured }
  }
  return geminiCache.configured
}

/** Gemini parses plans only when it is configured; otherwise the engine's free parser. */
export async function parsePlanAuto(text: string, ctx: PlanContext, signal?: AbortSignal): Promise<PlanDraft> {
  return (await geminiConfigured()) ? parsePlanText(text, ctx, signal) : parsePlanLocal(text, ctx, signal)
}

export const defaultFlowDeps: FlowDeps = {
  decide: voiceDecide, answer: voiceAnswer, guard: guardText, parsePlan: parsePlanAuto, geminiFirst: geminiConfigured,
}

/** Shown instead of a sentence the checks refused. Fixed text: no number, no judgement. */
export const HELD_MESSAGE = 'That answer did not pass the language checks, so it is not shown or spoken. Try asking another way.'

export async function runVoiceFlow(
  text: string,
  plan: PracticePlan,
  choices: Choices = {},
  deps: FlowDeps = defaultFlowDeps,
  signal?: AbortSignal,
  /** "Start a new plan": no memory — the words build a plan from scratch instead of editing `plan`. */
  fresh = false,
): Promise<VoiceOutcome> {
  const transcript = text.trim()
  const planCtx: PlanContext = fresh ? {} : { current_plan: plan }

  // Gemini on (key + paid APIs enabled): it reads the coach's words first, however they are phrased ("twenty more on
  // team period this time"), with the plan on screen. A plan change comes back as a draft for Confirm; a question
  // (about_plan: false) goes on to the local router below. If Gemini fails, the local path runs as before.
  if (deps.geminiFirst && Object.keys(choices).length === 0 && (await deps.geminiFirst())) {
    try {
      const draft = await deps.parsePlan(transcript, planCtx, signal)
      if (draft.about_plan !== false) return { kind: 'draft', transcript, draft }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      console.warn(`Gemini plan reading failed (${(e as Error).message}); using the local path.`)
    }
  }

  const routed = await deps.decide({ text: transcript, plan, choices }, signal)

  if (routed.abstain) {
    // Unsure: never act on the top choice. Ask with the two most probable options (nothing to offer → hold, say so).
    if (routed.did_you_mean.length > 0 && routed.asking) {
      return { kind: 'choose', transcript, asking: routed.asking, options: routed.did_you_mean.slice(0, 2), choices }
    }
    return { kind: 'held', transcript, reason: 'the router was unsure and had no options to offer' }
  }

  if (routed.intent === 'plan_entry') {
    const draft = await deps.parsePlan(transcript, planCtx, signal)
    return { kind: 'draft', transcript, draft }
  }

  const answer = await deps.answer({ intent: routed.intent, slots: routed.slots, plan, question: transcript }, signal)
  const ap = await approveAnswer(answer, deps.guard)
  if (!ap.ok) {
    console.warn(`Voice reply held — ${ap.reason}. Not shown or spoken.`)
    return { kind: 'held', transcript, reason: ap.reason }
  }
  return { kind: 'answer', transcript, intent: routed.intent, say: ap.say, labels: ap.labels, backend: routed.backend }
}

/** The coach tapped one option of "Did you mean …?": ask again with that choice added (at most one more question follows). */
export function pickOption(outcome: Extract<VoiceOutcome, { kind: 'choose' }>, option: DidYouMeanOption): Choices {
  return { ...outcome.choices, ...option.choices }
}

/** Provenance labels worth printing next to an answer (short ones only; the long AT-settings label stays in the engine). */
export function provenanceLabels(labels: string[]): string[] {
  return labels.filter((l) => /synthetic|fixture|replay|demo|boundary/i.test(l) && l.length < 64)
}
