import { describe, expect, it } from 'vitest'
import type { SimulationResult } from '../engineApi'
import {
  athleteAtMinute,
  basisLabel,
  displayName,
  fewestChangesNote,
  hottestPeakP95,
  indexAtMinute,
  isDemoPlan,
  minuteOfPeak,
  seriesByMinute,
  statusCounts,
  SYNTHETIC_PLAN_LABEL,
  valueAtMinute,
  withPlanLabel,
} from '../selectors'
import { DEFAULT_CONTRACT_PLAN } from '../fixtures'

// Test doubles shaped like an engine SimulationResult. The values are made up
// for the test only (they exercise index arithmetic, not physiology).
function sim(over: Partial<SimulationResult> = {}): SimulationResult {
  return {
    plan_id: 'p',
    step_min: 1,
    times: ['t1', 't2', 't3', 't4'],
    weather: [],
    athletes: [
      { id: 'a', name: 'A (fictional)', core_c_p50: [10, 11, 12, 13], core_c_p95: [20, 22, 24, 23], first_cross_min: 2, peak_core_c_p95: 24, status: 'over_limit' },
      { id: 'b', name: 'B (fictional)', core_c_p50: [1, 2, 3, 4], core_c_p95: [5, 6, 7, 8], first_cross_min: null, peak_core_c_p95: 8, status: 'below_limit' },
      { id: 'c', name: 'C', core_c_p50: [1, 1, 1, 1], core_c_p95: [2, 2, 2, 2], first_cross_min: null, peak_core_c_p95: 2, status: 'near_limit' },
    ],
    limit_core_c: 99,
    fhsaa_violations: [],
    training_load_met_min: 0,
    labels: ['estimate — planning only'],
    ...over,
  }
}

describe('engine time axis', () => {
  it('reads the latest output at or before minute m (times[k] = start + (k+1)·step)', () => {
    expect(indexAtMinute(1, 4, 0)).toBe(0) // before the first output → the first one
    expect(indexAtMinute(1, 4, 1)).toBe(0)
    expect(indexAtMinute(1, 4, 1.9)).toBe(0)
    expect(indexAtMinute(1, 4, 2)).toBe(1)
    expect(indexAtMinute(1, 4, 40)).toBe(3) // after the end → the last one
    expect(indexAtMinute(2, 4, 4)).toBe(1)
    expect(indexAtMinute(1, 0, 3)).toBe(-1)
  })

  it('never interpolates', () => {
    expect(valueAtMinute([10, 20], 1, 1.5)).toBe(10)
    expect(valueAtMinute([], 1, 1)).toBeNull()
  })

  it('builds one value per whole minute 0…total', () => {
    expect(seriesByMinute([10, 11, 12, 13], 1, 4)).toEqual([10, 10, 11, 12, 13])
    expect(seriesByMinute([10, 11], 2, 4)).toEqual([10, 10, 10, 10, 11])
  })

  it('places the peak at the end of its step', () => {
    expect(minuteOfPeak([20, 22, 24, 23], 1)).toBe(3)
    expect(minuteOfPeak([], 1)).toBeNull()
  })
})

describe('simulation summaries', () => {
  it('counts the engine status (p95 vs the line), not a web threshold', () => {
    expect(statusCounts(sim().athletes)).toEqual({ below_limit: 1, near_limit: 1, over_limit: 1 })
  })

  it('hottest forecast is the max engine peak_core_c_p95', () => {
    expect(hottestPeakP95(sim())).toBe(24)
    expect(hottestPeakP95(sim({ athletes: [] }))).toBeNull()
  })

  it('labels synthetic names "(fictional)" once', () => {
    expect(displayName('Marcus (fictional)', true)).toBe('Marcus (fictional)')
    expect(displayName('Marcus', true)).toBe('Marcus (fictional)')
    expect(displayName('Marcus', false)).toBe('Marcus')
  })
})

describe('athlete at a minute, no HR replay', () => {
  it('reads the plan forecast p50/p95 and the engine status/peak', () => {
    const a = athleteAtMinute({ id: 'a', minute: 2.4, totalMin: 4, plan: sim(), replay: null })!
    expect(a.basis).toBe('plan_forecast')
    expect(a.coreC).toBe(11)
    expect(a.p95C).toBe(22)
    expect(a.bandC).toBe(11)
    expect(a.peakP95C).toBe(24)
    expect(a.status).toBe('over_limit')
    expect(a.firstCrossMin).toBe(2)
    expect(a.flag).toBe(false)
    expect(a.hr).toBeNull()
    expect(a.history).toEqual([10, 10, 11])
    expect(a.forecast).toEqual([10, 10, 11, 12, 13])
    expect(basisLabel(a)).toBe('plan forecast only — no HR')
  })

  it('returns null for an athlete the engine did not simulate', () => {
    expect(athleteAtMinute({ id: 'zz', minute: 0, totalMin: 4, plan: sim(), replay: null })).toBeNull()
  })
})

describe('fewest-changes result in words (v1.4, decision 4)', () => {
  it('says "needs at least N changes" when the minimum compliant edit is over the cap', () => {
    expect(fewestChangesNote({ cap: 6, min_compliant_changes: 9, searched_caps: [6, 7, 8, 9], fell_back: false }, 9)).toBe(
      'Needs at least 9 changes — no plan with ≤ 6 changes meets every rule and keeps everyone under the line.',
    )
  })

  it('names the max-load plan when no capped plan qualified, and never says "fell back"', () => {
    const fell = fewestChangesNote({ cap: 6, min_compliant_changes: null, searched_caps: [6, 21], fell_back: true }, 21)
    expect(fell).toBe('No capped plan qualified; showing the max-load plan.')
    const notes = [
      fell,
      fewestChangesNote({ cap: 6, min_compliant_changes: null, searched_caps: [6], fell_back: false }),
      fewestChangesNote({ cap: 6, min_compliant_changes: 9, searched_caps: [6, 9], fell_back: false }),
      fewestChangesNote({ cap: 6, min_compliant_changes: 4, searched_caps: [6], fell_back: false }, 4),
    ]
    for (const n of notes) expect(n).not.toMatch(/fell back|fallback|fall back/i)
  })

  it('is quiet for max_load or an engine without `fewest_changes`', () => {
    expect(fewestChangesNote(undefined)).toBeNull()
    expect(fewestChangesNote(null, 21)).toBeNull()
    expect(fewestChangesNote({ cap: 6, min_compliant_changes: 4, searched_caps: [6], fell_back: false }, 4)).toBe('Fewest changes: 4 (cap 6).')
  })
})

describe('the engine demo plan (S1 / S2)', () => {
  const plan = DEFAULT_CONTRACT_PLAN
  const inputs = { plan, synthetic: { plan: true, roster: true, weather: false } }

  it('isDemoPlan: same id and drills, whatever the key order', () => {
    const reordered = { ...plan, drills: plan.drills.map((d) => Object.fromEntries(Object.entries(d).reverse()) as typeof d) }
    expect(isDemoPlan(plan, inputs)).toBe(true)
    expect(isDemoPlan(JSON.parse(JSON.stringify(plan)), inputs)).toBe(true)
    expect(isDemoPlan(reordered, inputs)).toBe(true)
  })

  it('isDemoPlan: an optimized or edited plan is not the demo plan', () => {
    const optimized = { ...plan, drills: [...plan.drills].reverse() } // same id, different drills
    const longer = { ...plan, drills: plan.drills.map((d, i) => (i === 0 ? { ...d, duration_min: d.duration_min + 5 } : d)) }
    expect(isDemoPlan(optimized, inputs)).toBe(false)
    expect(isDemoPlan(longer, inputs)).toBe(false)
    expect(isDemoPlan({ ...plan, id: 'plan-edited' }, inputs)).toBe(false)
    expect(isDemoPlan(plan, null)).toBe(false)
    expect(isDemoPlan(null, inputs)).toBe(false)
  })

  it('withPlanLabel adds "synthetic plan (fixture)" first, once, only for the synthetic demo plan', () => {
    expect(withPlanLabel(['synthetic roster'], plan, inputs)).toEqual([SYNTHETIC_PLAN_LABEL, 'synthetic roster'])
    expect(withPlanLabel(['synthetic roster', SYNTHETIC_PLAN_LABEL], plan, inputs)).toEqual(['synthetic roster', SYNTHETIC_PLAN_LABEL])
    expect(withPlanLabel(['x'], plan, { ...inputs, synthetic: { ...inputs.synthetic, plan: false } })).toEqual(['x'])
    expect(withPlanLabel(['x'], { ...plan, id: 'plan-edited' }, inputs)).toEqual(['x'])
    expect(withPlanLabel(['x'], plan, null)).toEqual(['x'])
  })
})
