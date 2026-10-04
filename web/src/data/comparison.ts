import { useEffect, useState } from 'react'
import { EngineError, getDemoComparison, isUnreachable, type DemoComparison } from './engineApi'

// "Compare weather inputs" (Plan screen): GET /demo/comparison, a stored
// snapshot of the same plan run under three weather inputs (CONTRACTS v1.4).
// Every number on the panel is a field of that response; nothing is computed
// here. 404 = the snapshot hasn't been generated yet.

export type ComparisonState =
  | { status: 'loading' }
  | { status: 'ready'; data: DemoComparison }
  | { status: 'missing' }
  | { status: 'error'; message: string }

function isComparison(x: unknown): x is DemoComparison {
  const c = x as DemoComparison
  return !!c && typeof c === 'object' && Array.isArray(c.rows) && Array.isArray(c.labels ?? [])
}

/** GET /demo/comparison → panel state (404 → missing; engine down → error). Abort errors are rethrown. */
export async function loadComparison(signal?: AbortSignal): Promise<ComparisonState> {
  try {
    const data = await getDemoComparison(signal)
    if (!isComparison(data)) return { status: 'error', message: 'the engine sent an unexpected comparison shape' }
    return { status: 'ready', data: { ...data, labels: data.labels ?? [] } }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof EngineError && e.status === 404) return { status: 'missing' }
    return { status: 'error', message: isUnreachable(e) ? 'the comparison needs the engine' : (e as Error).message }
  }
}

// A stored snapshot: once loaded it doesn't change while the app runs.
let cached: DemoComparison | null = null

export function useDemoComparison(): ComparisonState {
  const [state, setState] = useState<ComparisonState>(() => (cached ? { status: 'ready', data: cached } : { status: 'loading' }))
  useEffect(() => {
    if (cached) return
    const ctl = new AbortController()
    loadComparison(ctl.signal)
      .then((s) => {
        if (s.status === 'ready') cached = s.data
        setState(s)
      })
      .catch(() => {
        /* aborted on unmount */
      })
    return () => ctl.abort()
  }, [])
  return state
}
