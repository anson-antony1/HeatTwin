import { useMemo } from 'react'
import { useEngineMeta } from './engineMeta'
import { FIXTURE_ROSTER, ROSTER_IS_SYNTHETIC } from './fixtures'
import type { RosterAthlete } from './engineApi'
import { displayName } from './selectors'

export interface RosterView {
  athletes: RosterAthlete[]
  /** The engine marks the demo roster synthetic: names carry "(fictional)". */
  synthetic: boolean
  /** False only in the offline fallback (the local copy of fixtures/roster.json). */
  fromEngine: boolean
  name: (id: string) => string
  byId: (id: string) => RosterAthlete | undefined
}

function view(athletes: RosterAthlete[], synthetic: boolean, fromEngine: boolean): RosterView {
  const map = new Map(athletes.map((a) => [a.id, a]))
  return {
    athletes,
    synthetic,
    fromEngine,
    byId: (id) => map.get(id),
    name: (id) => {
      const a = map.get(id)
      return a ? displayName(a.name, synthetic) : id
    },
  }
}

/** The roster the engine simulated (GET /demo/inputs). Offline: the local fixture copy (badged by the views). */
export function useRoster(): RosterView {
  const { inputs, link } = useEngineMeta()
  return useMemo(
    () =>
      inputs
        ? view(inputs.roster, inputs.synthetic.roster, true)
        : link === 'offline'
          ? view(FIXTURE_ROSTER, ROSTER_IS_SYNTHETIC, false)
          : view([], false, false),
    [inputs, link],
  )
}
