import type { Zone, ZoneId } from './types'

// Every number here is a placeholder until engine/constants.yaml lands with
// citations. The UI reads thresholds from this one place so swapping them in
// is a single edit. Status column mirrors the engine's convention.

export const THRESHOLDS = {
  /** Estimated core temp where a card moves to "watch". °C — placeholder, AT-owned. */
  watchC: 38.5,
  /** Estimated core temp alert line. °C — placeholder, AT-owned. */
  alertC: 39.0,
  /** Minutes over the line before we raise an alert (persistence gate). */
  persistMin: 2,
  /** Once raised, an alert holds until the estimate drops this far below the line. */
  clearBelowC: 0.3,
  baselineC: 37.0,
} as const

// FHSAA heat-stress zones by WBGT (°F). Values need verifying against the
// current FHSAA policy before anyone relies on them.
export const ZONES: Zone[] = [
  { id: 'green', label: 'Normal activity', minWbgtF: 0, maxPracticeMin: null, breaksPerHour: 0, gearRule: 'Full gear allowed' },
  { id: 'yellow', label: 'Use discretion', minWbgtF: 80, maxPracticeMin: null, breaksPerHour: 2, gearRule: 'Full gear allowed' },
  { id: 'orange', label: 'Increased caution', minWbgtF: 85, maxPracticeMin: 180, breaksPerHour: 3, gearRule: 'Consider removing pads' },
  { id: 'red', label: 'Limit intensity', minWbgtF: 87.1, maxPracticeMin: 120, breaksPerHour: 4, gearRule: 'Helmets & shells only' },
  { id: 'black', label: 'No outdoor practice', minWbgtF: 90.1, maxPracticeMin: 0, breaksPerHour: 0, gearRule: 'Move indoors' },
]

export function zoneFor(wbgtF: number): Zone {
  let z = ZONES[0]
  for (const zone of ZONES) if (wbgtF >= zone.minWbgtF) z = zone
  return z
}

export const ZONE_COLOR: Record<ZoneId, string> = {
  green: 'var(--zone-green)',
  yellow: 'var(--zone-yellow)',
  orange: 'var(--zone-orange)',
  red: 'var(--zone-red)',
  black: 'var(--zone-black)',
}

export const SAFETY_LINE =
  'Estimated core temperature is for planning and early warning only. It never diagnoses, and it never decides when to stop cooling — only rectal temperature does.'
