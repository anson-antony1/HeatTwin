// One formatter for every core-temperature estimate or peak the UI prints next
// to the planning line. Two decimals, so a peak just under the line (38.95,
// 38.98) never reads as the line itself ("39.0°"). Display only: the number is
// the engine's; nothing here models anything.

/** Decimals for any core estimate or peak shown against the planning line. */
export const CORE_DECIMALS = 2

const SCALE = 10 ** CORE_DECIMALS

/**
 * The value to print with CORE_DECIMALS. A value below the line whose rounding
 * would land on (or over) the line is printed one step under it instead
 * (38.996 with a 39.0 line → 38.99), so the text never contradicts the
 * engine's below/over status. Values at or over the line are unchanged.
 */
export function coreValue(c: number, limit?: number | null): number {
  if (limit == null || !Number.isFinite(c) || !Number.isFinite(limit) || c >= limit) return c
  const rounded = Math.round(c * SCALE) / SCALE
  return rounded >= limit ? (Math.round(limit * SCALE) - 1) / SCALE : c
}

/**
 * Round like the engine (Python's round(): an exact half goes to the even digit), so the screen and Kelvin's spoken
 * sentence show the same number (41.125 → 41.12 on both; toFixed alone would print 41.13).
 */
export function roundLikeEngine(x: number, decimals: number): number {
  if (!Number.isFinite(x)) return x
  // toFixed(n) is exact for the stored binary value, so a true tie shows as "…5000…0" and anything else does not
  // (41.645 is stored as 41.64500000000000312… → up; 41.125 is exact → even).
  const s = Math.abs(x).toFixed(Math.min(100, decimals + 30))
  const dot = s.indexOf('.')
  const kept = s.slice(0, dot + 1 + decimals)
  const rest = s.slice(dot + 1 + decimals)
  const m = 10 ** decimals
  let units = Math.round(Number(kept) * m)
  const tie = /^50*$/.test(rest)
  if ((tie && units % 2 === 1) || (!tie && rest[0] >= '5')) units += 1
  return (Math.sign(x) || 1) * units / m
}

/** "38.99" — a core estimate or peak, never rounded onto the planning line. "—" when there is no number. */
export function fmtCore(c: number | null | undefined, limit?: number | null): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return roundLikeEngine(coreValue(c, limit), CORE_DECIMALS).toFixed(CORE_DECIMALS)
}
