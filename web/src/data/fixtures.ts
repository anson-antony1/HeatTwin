import type { Athlete, Drill, WeatherHour } from './types'

// Demo fixtures. Names are fictional. Replace with fixtures/ from the repo
// root (or live API calls) once the engine is serving them.

export const ROSTER: Athlete[] = [
  { id: 'a01', name: 'Marcus Bell', number: 72, position: 'OL', massKg: 134, heightCm: 193, acclimDay: 2, hrRest: 68, hrMax: 196, hasStrap: true },
  { id: 'a02', name: 'Devon Price', number: 55, position: 'DL', massKg: 124, heightCm: 188, acclimDay: 2, hrRest: 64, hrMax: 198, hasStrap: true },
  { id: 'a03', name: 'Tyler Ruiz', number: 64, position: 'OL', massKg: 128, heightCm: 190, acclimDay: 6, hrRest: 66, hrMax: 197, hasStrap: false },
  { id: 'a04', name: 'Jalen Ford', number: 44, position: 'LB', massKg: 104, heightCm: 185, acclimDay: 9, hrRest: 58, hrMax: 201, hasStrap: true },
  { id: 'a05', name: 'Chris Okafor', number: 88, position: 'TE', massKg: 109, heightCm: 193, acclimDay: 4, hrRest: 61, hrMax: 199, hasStrap: true },
  { id: 'a06', name: 'Andre Lewis', number: 22, position: 'RB', massKg: 91, heightCm: 178, acclimDay: 11, hrRest: 55, hrMax: 203, hasStrap: true },
  { id: 'a07', name: 'Sam Whitaker', number: 12, position: 'QB', massKg: 93, heightCm: 188, acclimDay: 12, hrRest: 57, hrMax: 202, hasStrap: true },
  { id: 'a08', name: 'Nico Alvarez', number: 1, position: 'WR', massKg: 80, heightCm: 183, acclimDay: 8, hrRest: 54, hrMax: 205, hasStrap: false },
  { id: 'a09', name: 'Isaiah Grant', number: 5, position: 'DB', massKg: 82, heightCm: 180, acclimDay: 3, hrRest: 56, hrMax: 204, hasStrap: true },
  { id: 'a10', name: 'Ben Carter', number: 31, position: 'DB', massKg: 85, heightCm: 182, acclimDay: 10, hrRest: 58, hrMax: 203, hasStrap: true },
  { id: 'a11', name: 'Kofi Mensah', number: 97, position: 'DL', massKg: 118, heightCm: 191, acclimDay: 5, hrRest: 63, hrMax: 199, hasStrap: true },
  { id: 'a12', name: 'Leo Hart', number: 3, position: 'K', massKg: 77, heightCm: 178, acclimDay: 13, hrRest: 52, hrMax: 205, hasStrap: false },
]

/**
 * Hidden per-athlete heat-production multiplier: what the athlete's body is
 * "really" doing relative to the population model. The live loop discovers it
 * from heart rate — the UI never reads this directly.
 */
export const TRUE_HEAT_FACTOR: Record<string, number> = {
  a01: 1.4, a02: 1.12, a03: 1.0, a04: 0.96, a05: 1.05, a06: 0.94,
  a07: 0.9, a08: 0.97, a09: 1.06, a10: 0.95, a11: 1.02, a12: 0.92,
}

export const PLAN: Drill[] = [
  { id: 'd1', name: 'Dynamic warm-up', kind: 'warmup', minutes: 12, met: 3.2, gear: 'helmet' },
  { id: 'd2', name: 'Individual period', kind: 'individual', minutes: 20, met: 4.6, gear: 'full' },
  { id: 'd3', name: 'Water break', kind: 'break', minutes: 4, met: 1.4, gear: 'full' },
  { id: 'd4', name: 'Inside run', kind: 'team', minutes: 18, met: 5.2, gear: 'full' },
  { id: 'd5', name: '7-on-7 / pass rush', kind: 'team', minutes: 16, met: 5.0, gear: 'full' },
  { id: 'd6', name: 'Water break', kind: 'break', minutes: 4, met: 1.4, gear: 'full' },
  { id: 'd7', name: 'Team period', kind: 'team', minutes: 22, met: 5.4, gear: 'full' },
  { id: 'd8', name: 'Conditioning', kind: 'conditioning', minutes: 14, met: 6.4, gear: 'shells' },
  { id: 'd9', name: 'Cool-down', kind: 'warmup', minutes: 8, met: 2.0, gear: 'helmet' },
]

export const FORECAST: WeatherHour[] = [
  { hour: 15, tempF: 93, rh: 52, windMph: 6, wbgtF: 87.6, source: 'forecast' },
  { hour: 16, tempF: 94, rh: 49, windMph: 7, wbgtF: 88.4, source: 'forecast' },
  { hour: 17, tempF: 92, rh: 51, windMph: 6, wbgtF: 87.2, source: 'forecast' },
  { hour: 18, tempF: 89, rh: 57, windMph: 5, wbgtF: 84.9, source: 'forecast' },
  { hour: 19, tempF: 85, rh: 64, windMph: 4, wbgtF: 81.8, source: 'forecast' },
]

export const PRACTICE_START_HOUR = 15.5
export const SCHOOL = 'Gainesville HS · Varsity'
