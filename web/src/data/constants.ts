// Display-only constants. No physiological, regulatory or physical numbers
// belong here: thresholds come from the engine result (`limit_core_c`) and GET
// /settings; FHSAA zones from the engine's WeatherHour.fhsaa_zone; rule text
// from GET /sources.

export type ZoneId = 'green' | 'yellow' | 'orange' | 'red' | 'black'

export interface Zone {
  id: ZoneId
  label: string
  minWbgtF: number
  maxPracticeMin: number | null
  breaksPerHour: number
  gearRule: string
}

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

/** Colour for an FHSAA zone number (1–5) from the engine. Display only. */
const ZONE_COLOR_BY_NUMBER: Record<number, string> = {
  1: ZONE_COLOR.green,
  2: ZONE_COLOR.yellow,
  3: ZONE_COLOR.orange,
  4: ZONE_COLOR.red,
  5: ZONE_COLOR.black,
}

export function zoneColor(zone: number | null | undefined): string {
  return (zone != null && ZONE_COLOR_BY_NUMBER[zone]) || 'var(--ink-4)'
}

export const ESTIMATE_LABEL = 'estimate — planning only'

export const SAFETY_LINE =
  'Estimated core temperature is an estimate — planning only. It never diagnoses, and it never decides when to stop cooling — only rectal temperature does.'
