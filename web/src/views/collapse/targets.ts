import type { SourcesJson } from '../../data/sourcesApi'
import { cToF } from '../../lib/heat'

// Cold-water-immersion numbers for the Collapse and Response screens. Every number comes from
// GET /sources (engine/constants.yaml). A block that is missing or not `status: VERIFIED` yields
// null, and the text helpers then fall back to wording without numbers. Nothing here is a literal
// physiological or regulatory value.

export interface CwiTargets {
  /** constants.yaml `ksi_cwi.source` / `nata_ehs.source`, for hover text. */
  ksiSource: string | null
  nataSource: string | null
  /** ksi_cwi.water_temp_c_max (KSI: "under 15C") */
  tubWaterMaxC: number | null
  /** ksi_cwi.no_rectal_thermometer_cool_min */
  noRectalCoolMin: [number, number] | null
  /** ksi_cwi.tub_within_min_of_field */
  tubWithinMin: [number, number] | null
  /** ksi_cwi.remove_at_rectal_c (KSI: "only after rectal temperature reaches 39C") */
  removeAtRectalC: number | null
  /** nata_ehs.goal_below_f_within_30min — the value (°F) */
  nataGoalF: number | null
  /** …and the window in minutes, read from that key's own name (`…within_30min`) */
  nataGoalWindowMin: number | null
}

export const NO_TARGETS: CwiTargets = {
  ksiSource: null,
  nataSource: null,
  tubWaterMaxC: null,
  noRectalCoolMin: null,
  tubWithinMin: null,
  removeAtRectalC: null,
  nataGoalF: null,
  nataGoalWindowMin: null,
}

function verifiedBlock(sources: unknown, key: string): Record<string, unknown> | null {
  if (typeof sources !== 'object' || sources === null) return null
  const b = (sources as SourcesJson)[key]
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return null
  const block = b as Record<string, unknown>
  return block.status === 'VERIFIED' ? block : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const a = num(v[0])
  const b = num(v[1])
  return a != null && b != null && a <= b ? [a, b] : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

/** Reads the numbers this UI needs out of a /sources body. Null/garbage input gives NO_TARGETS. */
export function extractCwiTargets(sources: unknown): CwiTargets {
  const ksi = verifiedBlock(sources, 'ksi_cwi')
  const nata = verifiedBlock(sources, 'nata_ehs')
  let goalF: number | null = null
  let goalWindow: number | null = null
  if (nata) {
    for (const k of Object.keys(nata)) {
      const m = /^goal_below_f_within_(\d+)min$/.exec(k)
      if (m) {
        goalF = num(nata[k])
        goalWindow = goalF != null ? Number(m[1]) : null
        break
      }
    }
  }
  return {
    ksiSource: ksi ? str(ksi.source) : null,
    nataSource: nata ? str(nata.source) : null,
    tubWaterMaxC: ksi ? num(ksi.water_temp_c_max) : null,
    noRectalCoolMin: ksi ? pair(ksi.no_rectal_thermometer_cool_min) : null,
    tubWithinMin: ksi ? pair(ksi.tub_within_min_of_field) : null,
    removeAtRectalC: ksi ? num(ksi.remove_at_rectal_c) : null,
    nataGoalF: goalF,
    nataGoalWindowMin: goalWindow,
  }
}

// ---------- formatting ----------

export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(+n.toFixed(1))
}

export function fmtRange(r: [number, number]): string {
  return r[0] === r[1] ? fmtNum(r[0]) : `${fmtNum(r[0])}–${fmtNum(r[1])}`
}

/** "15 °C (59 °F)" — °F is converted from the sourced °C, rounded to a whole degree. */
export function fmtCF(c: number): string {
  return `${fmtNum(c)} °C (${Math.round(cToF(c))} °F)`
}

// ---------- text built from the sourced numbers (each has a numbers-free fallback) ----------

/** "NATA goal: rectal temperature below 102.5 °F within 30 min — only a rectal thermometer can confirm" */
export function nataGoalText(t: CwiTargets): string {
  const tail = ' — only a rectal thermometer can confirm'
  if (t.nataGoalF == null) {
    return `NATA goal: rapid cooling to the NATA rectal-temperature target${tail}`
  }
  const win = t.nataGoalWindowMin != null ? `${t.nataGoalWindowMin} min` : 'the NATA time window'
  return `NATA goal: rectal temperature below ${fmtNum(t.nataGoalF)} °F within ${win}${tail}`
}

/** Short label under the clock digits. Empty when the window is not known. */
export function nataWindowLabel(t: CwiTargets): string {
  return t.nataGoalF != null && t.nataGoalWindowMin != null ? `NATA goal window: ${t.nataGoalWindowMin} min` : ''
}

/** "KSI: 10–15 min without a rectal reading" */
export function noRectalNote(t: CwiTargets): string {
  return t.noRectalCoolMin
    ? `KSI: ${fmtRange(t.noRectalCoolMin)} min without a rectal reading`
    : 'KSI: cooling time without a rectal reading is in the KSI guide'
}

/** "under 15 °C (59 °F)" or null */
export function tubWaterLimitText(t: CwiTargets): string | null {
  return t.tubWaterMaxC != null ? `under ${fmtCF(t.tubWaterMaxC)}` : null
}

/** "5–10 min" or null */
export function tubWithinText(t: CwiTargets): string | null {
  return t.tubWithinMin ? `${fmtRange(t.tubWithinMin)} min` : null
}

// ---------- protocol steps (wording follows the KSI Cold Water Immersion Guide) ----------

export interface Step {
  id: string
  title: string
  detail: string
  say: string
  /** Attribution shown under the detail. */
  source: string
}

export const EAP_NOTE = 'Follow your school’s emergency action plan; review this protocol with your athletic trainer.'

const KSI = 'KSI Cold Water Immersion Guide'

export function buildSteps(t: CwiTargets): Step[] {
  const water = tubWaterLimitText(t)
  const removeAt = t.removeAtRectalC != null ? fmtCF(t.removeAtRectalC) : null
  const noRectal = t.noRectalCoolMin ? fmtRange(t.noRectalCoolMin) : null
  const noRectalSpoken = t.noRectalCoolMin ? `${fmtNum(t.noRectalCoolMin[0])} to ${fmtNum(t.noRectalCoolMin[1])}` : null

  return [
    {
      id: 'call',
      title: 'Call 911',
      detail:
        'Say: “Athlete collapsed during practice in the heat; starting cold-water immersion.” Send someone to meet EMS and bring them to the athlete.',
      say: 'Call nine one one now. Say: athlete collapsed during practice in the heat; starting cold water immersion. Send someone to meet the ambulance.',
      source: `${KSI}, step 1`,
    },
    {
      id: 'tub',
      title: 'Into the tub',
      detail:
        'Place the athlete in the ice-water tub up to mid-chest or neck, with support. Cover as much of the body as possible; an assistant can hold the head and neck above the water.',
      say: 'Get the athlete into the ice water tub, up to mid chest or neck, with support. Keep the head and neck above the water.',
      source: `${KSI}, steps 4–5`,
    },
    {
      id: 'stir',
      title: 'Stir the water',
      detail: water
        ? `Keep the water continuously circulating or stirred. KSI water temperature: ${water}; use the ice beside the tub to keep it there.`
        : 'Keep the water continuously circulating or stirred. Use the ice beside the tub to keep the water cold.',
      say: 'Keep stirring the water so it keeps circulating. Use the ice beside the tub to keep the water cold.',
      source: `${KSI}, steps 5–6`,
    },
    {
      id: 'cool',
      title: 'Keep cooling',
      detail: [
        removeAt
          ? `KSI: continue cooling until rectal temperature lowers to ${removeAt}.`
          : 'KSI gives a rectal-temperature target for cooling.',
        noRectal
          ? `If rectal temperature cannot be measured, KSI says cool ${noRectal} minutes, then transport.`
          : 'KSI gives a cooling time to use when rectal temperature cannot be measured.',
        'Only a rectal thermometer can confirm temperature.',
      ].join(' '),
      say: [
        'Keep cooling.',
        noRectalSpoken
          ? `If rectal temperature can’t be measured, K S I says cool for ${noRectalSpoken} minutes, then transport.`
          : 'If rectal temperature can’t be measured, check the K S I guide for the cooling time.',
        'Only a rectal thermometer can confirm temperature.',
      ].join(' '),
      source: `${KSI}, step 8`,
    },
    {
      id: 'handoff',
      title: 'Hand off to EMS',
      detail: [
        'Hand over to EMS and share the timeline below.',
        removeAt
          ? `KSI: remove the patient from the tub only after rectal temperature reaches ${removeAt}, then transfer via EMS.`
          : 'KSI ties removal from the tub to a rectal-temperature reading.',
        'Follow your emergency action plan and EMS direction.',
      ].join(' '),
      say: 'Hand off to E M S and share the timeline. Follow your emergency action plan and E M S direction.',
      source: `${KSI}, steps 9–10`,
    },
  ]
}
