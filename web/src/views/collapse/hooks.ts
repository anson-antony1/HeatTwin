import { useEffect, useState } from 'react'
import { fetchNodeLatest, fetchSources, type NodeLatest } from '../../data/sourcesApi'
import { extractCwiTargets, NO_TARGETS, type CwiTargets } from './targets'

/** How often Collapse mode re-reads /node/latest (UI refresh rate, not a physiological value). */
const NODE_POLL_MS = 5000

/** Sourced CWI numbers from GET /sources. NO_TARGETS until loaded, and if the engine is unreachable. */
export function useCwiTargets(): CwiTargets {
  const [targets, setTargets] = useState<CwiTargets>(NO_TARGETS)
  useEffect(() => {
    const ac = new AbortController()
    fetchSources({ signal: ac.signal })
      .then((s) => setTargets(extractCwiTargets(s)))
      .catch(() => {
        /* unreachable: keep NO_TARGETS so the text shows without numbers */
      })
    return () => ac.abort()
  }, [])
  return targets
}

export type NodeStatus = 'loading' | 'ok' | 'unreachable'

/** Latest field-node reading, polled while the component is mounted. */
export function useNodeLatest(pollMs = NODE_POLL_MS): { latest: NodeLatest | null; status: NodeStatus } {
  const [state, setState] = useState<{ latest: NodeLatest | null; status: NodeStatus }>({ latest: null, status: 'loading' })
  useEffect(() => {
    const ac = new AbortController()
    const tick = () =>
      fetchNodeLatest({ signal: ac.signal })
        .then((latest) => setState({ latest, status: 'ok' }))
        .catch(() => {
          if (!ac.signal.aborted) setState({ latest: null, status: 'unreachable' })
        })
    tick()
    const id = setInterval(tick, pollMs)
    return () => {
      clearInterval(id)
      ac.abort()
    }
  }, [pollMs])
  return state
}
