import type { Athlete, Drill, WeatherHour } from './types'
import type { ContractDrill, PracticePlan } from './llmPlan'
import { toUiDrills, type UiKind } from './llmPlan'
import rosterFile from '../../../fixtures/roster.json'
import planFile from '../../../fixtures/plan.json'

// Roster and default plan come from the engine's shared fixtures (repo-root
// fixtures/), so athlete ids line up with every /simulate and /optimize
// response. The roster is synthetic — names carry "(fictional)" in the file.

interface ContractAthlete {
  id: string
  name: string
  position?: string
  height_m: number
  mass_kg: number
  age_yr: number
  hr_rest_bpm?: number
  hr_max_bpm?: number
  acclimatization_day: number
}

// UI-only details the contract doesn't carry: jersey numbers and who has a
// paired strap today (for the live replay).
const JERSEY: Record<string, number> = {
  a01: 72, a02: 66, a03: 61, a04: 94, a05: 91, a06: 44, a07: 52, a08: 22,
  a09: 1, a10: 11, a11: 24, a12: 5, a13: 12, a14: 87, a15: 3, a16: 78,
}
const NO_STRAP = new Set(['a03', 'a09', 'a12', 'a15'])

export const ROSTER_IS_SYNTHETIC = Boolean((rosterFile as { synthetic?: boolean }).synthetic)

export const ROSTER: Athlete[] = (rosterFile.roster as ContractAthlete[]).map((a, i) => ({
  id: a.id,
  name: a.name.replace(/\s*\(fictional\)\s*/i, ''),
  number: JERSEY[a.id] ?? 50 + i,
  position: a.position ?? '—',
  massKg: a.mass_kg,
  heightCm: Math.round(a.height_m * 100),
  acclimDay: a.acclimatization_day,
  hrRest: a.hr_rest_bpm ?? 62,
  // Tanaka (2001) age-predicted max when the roster doesn't give one.
  hrMax: a.hr_max_bpm ?? Math.round(208 - 0.7 * a.age_yr),
  hasStrap: !NO_STRAP.has(a.id),
}))

/**
 * Hidden per-athlete deviation from what the plan model expects — what the
 * body is "really" doing. The live replay discovers it from heart rate; the UI
 * never reads it directly. Marcus is the demo athlete who runs hot.
 */
export const TRUE_HEAT_FACTOR: Record<string, number> = {
  a01: 1.36, a02: 1.08, a03: 1.04, a04: 1.02, a05: 0.96, a06: 1.0, a07: 1.03, a08: 0.97,
  a09: 0.95, a10: 0.98, a11: 0.94, a12: 1.0, a13: 0.97, a14: 0.95, a15: 0.92, a16: 1.06,
}

/** Metabolic rate per contract intensity, in PHS met units — for the browser-side stand-in model only. */
export const MET_BY_INTENSITY: Record<ContractDrill['intensity'], number> = {
  rest: 1.4,
  light: 3.0,
  moderate: 4.6,
  hard: 5.3,
  max: 6.4,
}

export function contractToUi(plan: PracticePlan): Drill[] {
  return toUiDrills(plan, (_kind: UiKind, d: ContractDrill) => d.met_override ?? MET_BY_INTENSITY[d.intensity]).map(
    (d) => ({ ...d, name: d.name.charAt(0).toUpperCase() + d.name.slice(1) }),
  )
}

export const DEFAULT_CONTRACT_PLAN = planFile.plan as unknown as PracticePlan

export const PLAN: Drill[] = contractToUi(DEFAULT_CONTRACT_PLAN)

export const FORECAST: WeatherHour[] = [
  { hour: 15, tempF: 93, rh: 52, windMph: 6, wbgtF: 87.6, source: 'forecast' },
  { hour: 16, tempF: 94, rh: 49, windMph: 7, wbgtF: 88.4, source: 'forecast' },
  { hour: 17, tempF: 92, rh: 51, windMph: 6, wbgtF: 87.2, source: 'forecast' },
  { hour: 18, tempF: 89, rh: 57, windMph: 5, wbgtF: 84.9, source: 'forecast' },
  { hour: 19, tempF: 85, rh: 64, windMph: 4, wbgtF: 81.8, source: 'forecast' },
]

export const PRACTICE_START_HOUR = 15.5
export const SCHOOL = 'Gainesville HS · Varsity'
