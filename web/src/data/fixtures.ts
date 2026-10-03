import type { Athlete } from './types'
import type { RosterAthlete } from './engineApi'
import type { PracticePlan } from './llmPlan'
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

// Legacy UI shape for CollapseMode / VoiceDock. Jersey numbers are a UI-only
// detail the contract doesn't carry (not engine data).
const JERSEY: Record<string, number> = {
  a01: 72, a02: 66, a03: 61, a04: 94, a05: 91, a06: 44, a07: 52, a08: 22,
  a09: 1, a10: 11, a11: 24, a12: 5, a13: 12, a14: 87, a15: 3, a16: 78,
}

export const ROSTER: Athlete[] = FIXTURE_ROSTER.map((a, i) => ({
  id: a.id,
  name: a.name.replace(/\s*\(fictional\)\s*/i, ''),
  number: JERSEY[a.id] ?? i + 1,
  position: a.position ?? '—',
  massKg: a.mass_kg,
  heightCm: Math.round(a.height_m * 100),
  acclimDay: a.acclimatization_day,
}))

/** fixtures/plan.json — the same file /demo/inputs serves. Replaced by the engine's copy once it answers. */
export const DEFAULT_CONTRACT_PLAN = planFile.plan as unknown as PracticePlan

export const SCHOOL = 'Gainesville HS · Varsity'
