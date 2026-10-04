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

/** "38.99" — a core estimate or peak, never rounded onto the planning line. "—" when there is no number. */
export function fmtCore(c: number | null | undefined, limit?: number | null): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return coreValue(c, limit).toFixed(CORE_DECIMALS)
}
