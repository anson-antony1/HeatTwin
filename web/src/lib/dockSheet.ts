import type { PlanDraft } from '../data/llmPlan'

export type SheetView = 'review' | 'confirm' | 'result' | 'error' | 'typing'

/**
 * Which sheet the Kelvin dock shows. A Gemini draft with drills always stops at `confirm` until the coach presses
 * Confirm (`appliedDraft` is the draft they confirmed) — nothing reaches /simulate before that.
 */
export function dockSheet(a: {
  errorMsg: string | null
  draft: PlanDraft | null
  appliedDraft: PlanDraft | null
  opened: 'result' | 'typing' | null
  hasSim: boolean
}): SheetView | null {
  if (a.errorMsg) return 'error'
  if (a.draft && a.draft.plan.drills.length === 0) return 'review'
  if (a.draft && a.appliedDraft !== a.draft) return 'confirm'
  if (a.opened === 'typing') return 'typing'
  if (a.opened === 'result' && a.hasSim) return 'result'
  return null
}
