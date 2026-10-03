import { describe, expect, it } from 'vitest'
import type { SimulationResult } from '../engineApi'
import {
  athleteAtMinute,
  basisLabel,
  displayName,
  hottestPeakP95,
  indexAtMinute,
  minuteOfPeak,
  seriesByMinute,
  statusCounts,
  valueAtMinute,
} from '../selectors'

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
