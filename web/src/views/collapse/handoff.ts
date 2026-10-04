import type { Athlete } from '../../data/types'
import { mmss } from '../../lib/heat'

// The text "Copy for EMS" puts on the clipboard. Only what this screen knows:
// the roster entry (the demo roster is fictional, and the name says so), the
// steps the coach tapped with their times, and the tub reading line. No core
// estimate — only a rectal temperature informs care (KSI).

export interface HandoffEntry {
  /** Seconds since Collapse mode started. */
  t: number
  text: string
}

export function emsHandoffText(athlete: Pick<Athlete, 'name' | 'position' | 'massKg'>, log: HandoffEntry[], tubLine: string): string {
  return [
    `HeatTwin — EMS handoff · ${athlete.name} (${athlete.position}, ${athlete.massKg} kg, roster entry)`,
    'Times are since Collapse mode started on this screen.',
    ...log.map((e) => `+${mmss(e.t)}  ${e.text}`),
    tubLine,
    'Rectal temperature is the only basis for treatment decisions.',
  ].join('\n')
}
