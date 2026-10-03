import rosterFile from '../../../fixtures/roster.json'
import type { PlanState } from '../data/planStore'
import type { RosterName } from './localAnswer'

// Athlete names for the local router (typed questions when the intent service is down). The panel doesn't send a
// roster, so the engine simulates its own roster; we match against the athletes the engine returned for the plan on
// screen, or — before any simulation — the same fixture roster the engine uses by default (names are fictional).
export function voiceRoster(state: Pick<PlanState, 'sim'>): RosterName[] {
  const sim = state.sim?.athletes
  if (sim?.length) return sim.map((a) => ({ id: a.id, name: a.name ?? a.id }))
  return (rosterFile.roster as { id: string; name: string }[]).map((a) => ({ id: a.id, name: a.name }))
}
