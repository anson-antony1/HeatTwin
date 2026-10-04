import type { Athlete } from './types'
import type { RosterAthlete } from './engineApi'
import type { PracticePlan } from './llmPlan'
import { displayName } from './selectors'
import rosterFile from '../../../fixtures/roster.json'
import planFile from '../../../fixtures/plan.json'

// Local copies of the engine's shared fixtures (repo-root fixtures/). Online,
// the screens show the plan and roster the engine returns from GET /demo/inputs
// — these copies are only (a) the plan the store holds before that answer
// arrives, (b) the roster the offline fallback draws, and (c) the legacy
// roster shape Collapse mode and the voice dock still read (owned elsewhere).

/** Contract-shaped roster from fixtures/roster.json. Offline fallback only. */
export const FIXTURE_ROSTER: RosterAthlete[] = rosterFile.roster as RosterAthlete[]
export const ROSTER_IS_SYNTHETIC = Boolean((rosterFile as { synthetic?: boolean }).synthetic)

// Legacy UI shape for CollapseMode / VoiceDock. Names keep "(fictional)" — the
// roster is synthetic, and every screen and the EMS hand-off text must say so.
// No jersey numbers: the contract doesn't carry one, and an invented number
// would read as a real athlete's.
export const ROSTER: Athlete[] = FIXTURE_ROSTER.map((a) => ({
  id: a.id,
  name: displayName(a.name, ROSTER_IS_SYNTHETIC),
  position: a.position ?? '—',
  massKg: a.mass_kg,
  heightCm: Math.round(a.height_m * 100),
  acclimDay: a.acclimatization_day,
}))

/** fixtures/plan.json — the same file /demo/inputs serves. Replaced by the engine's copy once it answers. */
export const DEFAULT_CONTRACT_PLAN = planFile.plan as unknown as PracticePlan

/** The demo roster is fictional; never name a real school or team. */
export const SCHOOL = 'Demo team (fictional roster)'
