// Display-only constants. No physiological, regulatory or physical numbers
// belong here: the planning line comes from the engine result
// (`limit_core_c`) and GET /settings; FHSAA zones from the engine's
// WeatherHour.fhsaa_zone; zone rule text from GET /sources.

/** Colour for an FHSAA zone number (1–5) from the engine. Display only. */
const ZONE_COLOR_BY_NUMBER: Record<number, string> = {
  1: 'var(--zone-green)',
  2: 'var(--zone-yellow)',
  3: 'var(--zone-orange)',
  4: 'var(--zone-red)',
  5: 'var(--zone-black)',
}

export function zoneColor(zone: number | null | undefined): string {
  return (zone != null && ZONE_COLOR_BY_NUMBER[zone]) || 'var(--ink-4)'
}

export const ESTIMATE_LABEL = 'estimate — planning only'

export const SAFETY_LINE =
  'Estimated core temperature is an estimate — planning only. It never diagnoses, and it never decides when to stop cooling — only rectal temperature does.'
