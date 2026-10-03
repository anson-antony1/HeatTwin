// Legacy roster shape still read by Collapse mode and the voice dock (owned by
// other workstreams). New code reads the engine's shapes in ./engineApi.ts.

export type Position = 'OL' | 'DL' | 'LB' | 'TE' | 'RB' | 'QB' | 'WR' | 'DB' | 'K' | string

export interface Athlete {
  id: string
  name: string
  number: number
  position: Position
  massKg: number
  heightCm: number
  /** Days practiced in the heat this preseason. */
  acclimDay: number
}
