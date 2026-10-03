import { describe, expect, it } from 'vitest'
import { CORE_DECIMALS, coreValue, fmtCore } from '../format'

// Peaks never round onto the planning line (demo-QA: 38.995 and 38.95 showed as "39.0°").
// Lines here are test values; 37.5 is deliberately not a real default.

describe('fmtCore', () => {
  it('prints two decimals', () => {
    expect(CORE_DECIMALS).toBe(2)
    expect(fmtCore(38.95)).toBe('38.95')
    expect(fmtCore(41.645)).toBe('41.65')
    expect(fmtCore(38.98, 39)).toBe('38.98')
  })

  it('never prints a value below the line as the line', () => {
    expect(fmtCore(38.995, 39)).toBe('38.99')
    expect(fmtCore(38.996, 39)).toBe('38.99')
    expect(fmtCore(38.9999, 39)).toBe('38.99')
    expect(fmtCore(37.4961, 37.5)).toBe('37.49')
  })

  it('leaves values at or over the line alone', () => {
    expect(fmtCore(39, 39)).toBe('39.00')
    expect(fmtCore(39.004, 39)).toBe('39.00')
    expect(fmtCore(40.931, 39)).toBe('40.93')
  })

  it('handles missing numbers and missing lines', () => {
    expect(fmtCore(null)).toBe('—')
    expect(fmtCore(Number.NaN, 39)).toBe('—')
    expect(fmtCore(38.996)).toBe('39.00') // no line to compare with: plain rounding
    expect(coreValue(38.5, null)).toBe(38.5)
  })
})
