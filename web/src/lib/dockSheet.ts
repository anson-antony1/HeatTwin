import type { PlanDraft } from '../data/llmPlan'

export type SheetView = 'review' | 'confirm' | 'result' | 'error' | 'typing' | 'answer' | 'choose'

/**
 * Which sheet the Kelvin dock shows. A plan draft with drills always stops at `confirm` until the coach presses
 * Confirm (`appliedDraft` is the draft they confirmed) — nothing reaches /simulate before that. A question is answered on
 * `answer` (the engine's sentence, already guarded and number-checked, or the fixed "held" message); when the decision layer
 * is not sure it asks on `choose` ("Did you mean …?", two options) and nothing else happens until the coach taps one.
 */
export function dockSheet(a: {
  errorMsg: string | null
  draft: PlanDraft | null
  appliedDraft: PlanDraft | null
  opened: 'result' | 'typing' | null
  hasSim: boolean
  /** v1.7: the outcome kind of the last utterance when it is not a plan draft. */
  voice?: 'answer' | 'held' | 'choose' | null
}): SheetView | null {
  if (a.errorMsg) return 'error'
  if (a.voice === 'choose') return 'choose'
  if (a.voice === 'answer' || a.voice === 'held') return 'answer'
  if (a.draft && a.draft.plan.drills.length === 0) return 'review'
  if (a.draft && a.appliedDraft !== a.draft) return 'confirm'
  if (a.opened === 'typing') return 'typing'
  if (a.opened === 'result' && a.hasSim) return 'result'
  return null
}
