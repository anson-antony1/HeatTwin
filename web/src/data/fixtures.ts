import type { RosterAthlete } from './engineApi'
import type { PracticePlan } from './llmPlan'
import rosterFile from '../../../fixtures/roster.json'
import planFile from '../../../fixtures/plan.json'

// Local copies of the engine's shared fixtures (repo-root fixtures/). Online,
// the screens show the plan and roster the engine returns from GET /demo/inputs.
// These copies are only the plan STRUCTURE (drills, names, roster) the screens
// show while the engine is unreachable — badged "offline fallback", with "—"
// wherever a number would be. No jersey numbers, no strap list, no "true" heat:
// the contract carries none of them.

/** Contract-shaped roster from fixtures/roster.json. Offline fallback only. */
export const FIXTURE_ROSTER: RosterAthlete[] = rosterFile.roster as RosterAthlete[]
export const ROSTER_IS_SYNTHETIC = Boolean((rosterFile as { synthetic?: boolean }).synthetic)

/** fixtures/plan.json — the same file /demo/inputs serves. Replaced by the engine's copy once it answers. */
export const DEFAULT_CONTRACT_PLAN = planFile.plan as unknown as PracticePlan
