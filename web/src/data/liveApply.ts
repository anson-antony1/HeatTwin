import { postLiveApply } from './engineApi'
import { liveStore } from './liveStore'
import { planStore } from './planStore'

/**
 * v1.7: the coach applies the engine's live suggestion for one athlete. The live session switches to the changed plan
 * (keeping every calibration); the plan view lands the same plan as an edit (Undo returns to the previous one).
 */
export async function applyLiveSuggestion(athleteId: string): Promise<void> {
  const res = await postLiveApply(athleteId)
  await planStore.applyPlan(res.plan)
  await liveStore.refresh()
}
