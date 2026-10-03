import { ESTIMATE_LABEL } from '../data/constants'

// Order and tone for provenance chips (<ProvenanceLabels/>). Only a few chips
// show until the list is expanded, so the ones a viewer must not miss come
// first: OFFLINE FALLBACK, then anything synthetic / fixture / replay / demo,
// then "uses unverified constants"; the rest keep the engine's order.

const OFFLINE = /offline fallback/i
const SYNTHETIC = /synthetic|fixture|fictional|replay|demo/i
const UNVERIFIED = /unverified constants/i

function rank(label: string): number {
  if (OFFLINE.test(label)) return 0
  if (SYNTHETIC.test(label)) return 1
  if (UNVERIFIED.test(label)) return 2
  return 3
}

/** De-duplicated labels (without the pinned estimate chip), most important first; stable within a rank. */
export function orderLabels(labels: string[]): string[] {
  const unique = [...new Set(labels.filter((l) => l && l !== ESTIMATE_LABEL))]
  return unique
    .map((l, i) => ({ l, i, r: rank(l) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.l)
}

/** Chip colour: OFFLINE FALLBACK red, provenance caveats amber, the rest neutral. */
export function labelTone(label: string): '' | 'warn' | 'offline' {
  if (OFFLINE.test(label)) return 'offline'
  if (/synthetic|fixture|fictional|replay|demo|unverified|stand-in|TODO/i.test(label)) return 'warn'
  return ''
}
