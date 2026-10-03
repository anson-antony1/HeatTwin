// Shapes the in-browser stand-in model works in. OFFLINE FALLBACK ONLY: nothing
// online reads these. When the engine is reachable, views render engine
// responses (src/data/engineApi.ts) directly.

export type StandInGear = 'none' | 'helmet' | 'shells' | 'full'
export type StandInKind = 'warmup' | 'individual' | 'team' | 'conditioning' | 'break'

export interface StandInAthlete {
  id: string
  massKg: number
  heightCm: number
  acclimDay: number
}

export interface StandInDrill {
  id: string
  name: string
  kind: StandInKind
  minutes: number
  /** Metabolic intensity in PHS met units (1 met = 58.2 W/m²) — stand-in values, not the engine's. */
  met: number
  gear: StandInGear
}

export interface StandInWeatherHour {
  /** Local hour, 24 h. */
  hour: number
  wbgtF: number
}
