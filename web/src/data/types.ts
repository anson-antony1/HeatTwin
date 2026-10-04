// UI-side shapes. Engine shapes live in ./engineApi.ts (CONTRACTS.md); pure
// mappings from them in ./selectors.ts.

export type { AthleteLive, ChartDrill, DrillKind, LiveBasis, Tone } from './selectors'

/** Pill / row tone for an engine status (`below_limit` → steady, `near_limit` → watch, `over_limit` → alert). */
export type Status = 'steady' | 'watch' | 'alert' | 'none'
