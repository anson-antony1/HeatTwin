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

let cache: { key: unknown; v: RosterView } | null = null

/** The roster the engine simulated (GET /demo/inputs). Offline: the local fixture copy (badged by the views). */
export function useRoster(): RosterView {
  const meta = useEngineMeta()
  const key = meta.inputs ?? meta.link
  if (cache?.key === key) return cache.v
  const v = meta.inputs
    ? view(meta.inputs.roster, meta.inputs.synthetic.roster, true)
    : meta.link === 'offline'
      ? view(FIXTURE_ROSTER, ROSTER_IS_SYNTHETIC, false)
      : view([], false, false)
  cache = { key, v }
  return v
}
