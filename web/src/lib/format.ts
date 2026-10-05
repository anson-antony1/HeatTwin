// One formatter for every core-temperature estimate or peak the UI prints next
// to the planning line. Display only: the number is the engine's; nothing here
// models anything. The engine works in °C; everything here prints °F (cToF, the
// same 1.8·c + 32 the engine uses in engine/units.py).
import { cToF } from './heat'

/** Decimals for a peak or a value printed against the planning line (matches docs/demo_numbers.md and Kelvin). */
export const PEAK_DECIMALS = 2

/**
 * Round like the engine (Python's round(): an exact half goes to the even digit), so the screen and Kelvin's
 * sentence show the same number (41.125 → 41.12 on both; toFixed alone would print 41.13).
 */
export function roundLikeEngine(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x
  // toFixed(n) is exact for the stored binary value, so a true tie shows as "…5000…0" and anything else does not.
  const s = Math.abs(x).toFixed(Math.min(100, decimals + 30))
  const dot = s.indexOf('.')
  const kept = s.slice(0, dot + 1 + decimals)
  const rest = s.slice(dot + 1 + decimals)
  const m = 10 ** decimals
  let units = Math.round(Number(kept) * m)
  const tie = /^50*$/.test(rest)
  if ((tie && units % 2 === 1) || (!tie && rest[0] >= '5')) units += 1
  return ((Math.sign(x) || 1) * units) / m
}

/**
 * The value to print with `decimals`. A value below the line whose rounding would land on (or over) the line is
 * printed one step under it instead (38.996 with a 39.0 line → 38.99), so the text never contradicts the engine's
 * below/over status. Values at or over the line, and values with no line, are only rounded.
 */
export function coreValue(cC: number, limitC: number | null | undefined, decimals: number): number {
  if (!Number.isFinite(cC)) return cC
  const c = cToF(cC)
  const limit = limitC == null || !Number.isFinite(limitC) ? limitC : cToF(limitC)
  const scale = 10 ** decimals
  const rounded = roundLikeEngine(c, decimals)
  if (limit == null || !Number.isFinite(limit) || c >= limit) return rounded
  return rounded >= limit ? (Math.ceil(limit * scale - 1e-9) - 1) / scale : rounded
}

/** "102.16" — a core estimate or peak in °F (engine value in °C); "—" when there is no number. */
export function fmtCore(c: number | null | undefined, limit?: number | null, decimals = PEAK_DECIMALS): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return coreValue(c, limit, decimals).toFixed(decimals)
}

/** NumberTicker input: the rounded engine value, or NaN (the ticker prints "—"). */
export function tickerCore(c: number | null | undefined, limit?: number | null, decimals = PEAK_DECIMALS): number {
  return c == null || !Number.isFinite(c) ? Number.NaN : coreValue(c, limit, decimals)
}

/** The planning line in °F as written next to a temperature ("102.2"); "—" when unknown. */
export function fmtLimit(limit: number | null | undefined): string {
  return limit == null || !Number.isFinite(limit) ? '—' : roundLikeEngine(cToF(limit), 1).toFixed(1)
}

/** A temperature DIFFERENCE (a ± band, a reduction) from °C to °F — no +32. */
export function fmtDelta(dc: number | null | undefined, decimals = PEAK_DECIMALS): string {
  return dc == null || !Number.isFinite(dc) ? '—' : roundLikeEngine(dc * 1.8, decimals).toFixed(decimals)
}

/** A whole number from the engine (counts, minutes), or "—". */
export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? '—' : String(Math.round(n))
}

/** NumberTicker input for a count that may be missing (NaN prints "—"). */
export function tickerInt(n: number | null | undefined): number {
  return n == null || !Number.isFinite(n) ? Number.NaN : n
}
