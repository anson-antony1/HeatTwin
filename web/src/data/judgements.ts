import type { Sources } from './engineApi'

// DESIGN (justified modelling choices) and TODO entries from GET /sources (constants.yaml as JSON), for the Settings →
// "Judgement calls" card. Nothing here is computed: the words come from constants.yaml.

export interface Judgement {
  path: string
  status: 'DESIGN' | 'TODO'
  justification: string | null
  note: string | null
  source: string | null
}

/** Every block or nested entry whose status is DESIGN or TODO, sorted by path (justified ones first). */
export function judgements(sources: Sources | null | undefined): Judgement[] {
  const out: Judgement[] = []
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const o = node as Record<string, unknown>
    const st = typeof o.status === 'string' ? o.status.toUpperCase() : null
    if (path && (st === 'DESIGN' || st === 'TODO')) {
      out.push({
        path,
        status: st,
        justification: typeof o.justification === 'string' ? o.justification : null,
        note: typeof o.note === 'string' ? o.note : typeof o.mapping === 'string' ? o.mapping : null,
        source: typeof o.source === 'string' ? o.source : null,
      })
    }
    for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k)
  }
  walk(sources ?? null, '')
  return out.sort((a, b) => Number(!a.justification) - Number(!b.justification) || a.path.localeCompare(b.path))
}
