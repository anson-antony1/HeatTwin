import { describe, expect, it } from 'vitest'
import { coreValue, fmtCore, fmtLimit, roundLikeEngine, tickerCore } from '../format'

describe('peak formatting (2 decimals, rounded like Python)', () => {
  it('prints the demo headline peak as docs/demo_numbers.md does', () => {
    expect(fmtCore(38.98, 39.0)).toBe('38.98')
    expect(fmtCore(41.648, 39.0)).toBe('41.65')
  })

  it('rounds an exact half to even like Python round(), not up like toFixed', () => {
    expect(roundLikeEngine(41.125, 2)).toBe(41.12) // exact binary tie → even
    expect(roundLikeEngine(41.375, 2)).toBe(41.38)
    expect(roundLikeEngine(41.645, 2)).toBe(41.65) // stored just above the tie → up (Python agrees)
    expect(roundLikeEngine(0.5, 0)).toBe(0)
    expect(roundLikeEngine(1.5, 0)).toBe(2)
  })

  it('never prints a below-line value on (or over) the line', () => {
    expect(fmtCore(38.996, 39.0)).toBe('38.99')
    expect(coreValue(38.96, 39.0, 1)).toBe(38.9)
    expect(fmtCore(39.004, 39.0)).toBe('39.00') // at/over the line: only rounded
  })

  it('no number → "—" (and NaN for the ticker, which prints "—")', () => {
    expect(fmtCore(null)).toBe('—')
    expect(fmtCore(undefined)).toBe('—')
    expect(fmtLimit(null)).toBe('—')
    expect(fmtLimit(39)).toBe('39.0')
    expect(Number.isNaN(tickerCore(null))).toBe(true)
  })
})
