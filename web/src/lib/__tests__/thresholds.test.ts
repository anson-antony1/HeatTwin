import { describe, expect, it } from 'vitest'
import type { SettingsResponse, SimulationResult } from '../../data/engineApi'
import { nearMargin } from '../../data/selectors'
import { chartDomain, heatColor, heatStops, niceTicks } from '../heat'
import { heatScaleFrom } from '../useHeatScale'

// The planning line, near band and colour boundaries all come from engine
// responses. The numbers here are test values, deliberately unlike the real
// defaults, so a hidden web constant would show up as a failure.

const sim = {
  athletes: [
    { id: 'a', core_c_p50: [30.2, 31], core_c_p95: [31, 32], peak_core_c_p95: 32, status: 'over_limit' },
    { id: 'b', core_c_p50: [30.0, 30.5], core_c_p95: [30.4, 30.9], peak_core_c_p95: 30.9, status: 'below_limit' },
  ],
  limit_core_c: 31.5,
  settings: { planning_limit_core_c: 31.5, near_limit_margin_c: 0.7, clothing_mode: 'conservative' },
} as unknown as SimulationResult

const settings: SettingsResponse = {
  owner: 'athletic trainer',
  settings: [{ key: 'near_limit_margin_c', value: 0.5, default: 0.3 }],
}

describe('near band', () => {
  it('comes from GET /settings, else from the settings the run used', () => {
    expect(nearMargin(settings, sim)).toBe(0.5)
    expect(nearMargin(null, sim)).toBe(0.7)
    expect(nearMargin(null, null)).toBeNull()
  })
})

describe('heat colour scale', () => {
  it('anchors on the engine limit, near band and lowest starting p50', () => {
    expect(heatScaleFrom(sim, settings, null)).toEqual({ floor: 30.0, near: 31.0, limit: 31.5 })
    expect(heatScaleFrom(null, settings, null)).toBeNull()
  })

  it('puts the red end exactly at the planning line', () => {
    const scale = { floor: 30, near: 31, limit: 31.5 }
    const stops = heatStops(scale)
    expect(stops[0][0]).toBe(30)
    expect(stops[2][0]).toBe(31)
    expect(stops[4][0]).toBe(31.5)
    expect(heatColor(31.5, scale)).toBe(heatColor(45, scale))
    expect(heatColor(31.4, scale)).not.toBe(heatColor(31.5, scale))
  })

  it('draws neutral (no thresholds) until the engine answers', () => {
    expect(heatColor(40, null)).toBe(heatColor(20, null))
  })
})

describe('chart range', () => {
  it('always includes the planning line and every value', () => {
    const [lo, hi] = chartDomain([30, 30.4], [31.5])
    expect(lo).toBeLessThan(30)
    expect(hi).toBeGreaterThan(31.5)
  })

  it('ticks are round numbers inside the range', () => {
    const t = niceTicks([36.6, 41.8])
    expect(t.length).toBeGreaterThan(2)
    for (const v of t) {
      expect(v).toBeGreaterThan(36.6)
      expect(v).toBeLessThan(41.8)
    }
  })
})
