import { postLiveApply, type LiveSuggestion } from './engineApi'
import { liveStore } from './liveStore'
import { planStore } from './planStore'

/**
 * v1.7: the coach applies the engine's suggestion for one athlete. Live session: the session switches to the changed
 * plan (keeping every calibration) and the plan view lands the same plan. HR replay: the suggestion carries its plan,
 * which the plan view lands directly. Either way it is an edit, so Undo returns to the previous plan.
 */
export async function applyLiveSuggestion(athleteId: string, sug: LiveSuggestion): Promise<void> {
  if (sug.plan) {
    await planStore.applyPlan(sug.plan)
    return
  }
  const res = await postLiveApply(athleteId, sug.computed_at)
  await planStore.applyPlan(res.plan)
  await liveStore.refresh()
}
