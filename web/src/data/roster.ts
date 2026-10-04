import { useMemo } from 'react'
import { useEngineMeta, type EngineMeta } from './engineMeta'
import { FIXTURE_ROSTER, ROSTER_IS_SYNTHETIC } from './fixtures'
import type { RosterAthlete } from './engineApi'
import { shortName } from './selectors'

export interface RosterView {
  athletes: RosterAthlete[]
  /** The engine marks the demo roster synthetic (names carry "(fictional)" in the file). */
  synthetic: boolean
  /** False only in the offline fallback (the local copy of fixtures/roster.json). */
  fromEngine: boolean
  /** Name as the screens print it ("Marcus"); the screens carry a "synthetic roster" label when `synthetic`. */
  name: (id: string) => string
  /** Name as the engine wrote it ("Marcus (fictional)"), for the EMS hand-off text. */
  fullName: (id: string) => string
  /** Position for the badge where the old UI printed an invented jersey number. */
  badge: (id: string) => string
  byId: (id: string) => RosterAthlete | undefined
}

export const SYNTHETIC_ROSTER_LABEL = 'synthetic roster'

function view(athletes: RosterAthlete[], synthetic: boolean, fromEngine: boolean): RosterView {
  const map = new Map(athletes.map((a) => [a.id, a]))
  return {
    athletes,
    synthetic,
    fromEngine,
    byId: (id) => map.get(id),
    name: (id) => {
      const a = map.get(id)
      return a ? shortName(a.name) : id
    },
    fullName: (id) => map.get(id)?.name ?? id,
    badge: (id) => map.get(id)?.position ?? '—',
  }
}

/**
 * The roster the engine simulated (GET /demo/inputs). Until it answers, and while it is unreachable, the local
 * fixture copy — names and positions only; every number on those rows is "—" (and badged offline).
 */
export function rosterView(meta: Pick<EngineMeta, 'inputs'>): RosterView {
  if (meta.inputs) return view(meta.inputs.roster, meta.inputs.synthetic.roster, true)
  return view(FIXTURE_ROSTER, ROSTER_IS_SYNTHETIC, false)
}

export function useRoster(): RosterView {
  const { inputs } = useEngineMeta()
  return useMemo(() => rosterView({ inputs }), [inputs])
}
