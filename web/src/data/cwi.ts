import type { NodeLatest, Sources } from './engineApi'
import { cToF } from '../lib/heat'

// Cold-water-immersion numbers for the Response and Collapse screens. Every number comes from GET /sources
// (engine/constants.yaml); a block that is missing or not `status: VERIFIED` yields null, and the text helpers fall
// back to wording without numbers. The tub reading is GET /node/latest `reading.tub_temp_c` (null until a tub probe
// is wired). Nothing here is a literal physiological or regulatory value.

export interface CwiTargets {
  /** ksi_cwi.water_temp_c_max (KSI: water under 15 °C). */
  tubWaterMaxC: number | null
  /** ksi_cwi.no_rectal_thermometer_cool_min */
  noRectalCoolMin: [number, number] | null
  /** ksi_cwi.tub_within_min_of_field */
  tubWithinMin: [number, number] | null
  /** nata_ehs.goal_below_f_within_<N>min — the window N in minutes. */
  nataGoalWindowMin: number | null
  ksiSource: string | null
}

export const NO_TARGETS: CwiTargets = { tubWaterMaxC: null, noRectalCoolMin: null, tubWithinMin: null, nataGoalWindowMin: null, ksiSource: null }

function verified(sources: Sources | null | undefined, key: string): Record<string, unknown> | null {
  const b = sources?.[key]
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null
  const block = b as Record<string, unknown>
  return block.status === 'VERIFIED' ? block : null
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const a = num(v[0])
  const b = num(v[1])
  return a != null && b != null && a <= b ? [a, b] : null
}

export function cwiTargets(sources: Sources | null | undefined): CwiTargets {
  const ksi = verified(sources, 'ksi_cwi')
  const nata = verified(sources, 'nata_ehs')
  let window: number | null = null
  if (nata) {
    for (const k of Object.keys(nata)) {
      const m = /^goal_below_f_within_(\d+)min$/.exec(k)
      if (m && num(nata[k]) != null) window = Number(m[1])
    }
  }
  return {
    tubWaterMaxC: ksi ? num(ksi.water_temp_c_max) : null,
    noRectalCoolMin: ksi ? pair(ksi.no_rectal_thermometer_cool_min) : null,
    tubWithinMin: ksi ? pair(ksi.tub_within_min_of_field) : null,
    nataGoalWindowMin: window,
    ksiSource: ksi && typeof ksi.source === 'string' ? ksi.source : null,
  }
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toFixed(1)))

/** "10–15" or "—". */
export function fmtRange(r: [number, number] | null): string {
  if (!r) return '—'
  return r[0] === r[1] ? fmtNum(r[0]) : `${fmtNum(r[0])}–${fmtNum(r[1])}`
}

/** The KSI water limit in °F (converted from the sourced °C, whole degrees), or null. */
export function tubLimitF(t: CwiTargets): number | null {
  return t.tubWaterMaxC != null ? Math.round(cToF(t.tubWaterMaxC)) : null
}

/** The tub probe reading in °F, or null (no node, no reading, or no tub probe wired). */
export function tubReadingF(node: NodeLatest | null | undefined): number | null {
  const c = node?.reading?.tub_temp_c
  return typeof c === 'number' && Number.isFinite(c) ? cToF(c) : null
}

/** "mm:ss" for a whole number of minutes, or "—". */
export function minutesClock(min: number | null): string {
  return min == null ? '—' : `${String(min).padStart(2, '0')}:00`
}
