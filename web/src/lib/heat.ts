// Thermal palette. Cool lavender at the starting core estimate → amber at the
// near band → coral red at the planning line. The colour boundaries are NOT
// web constants: they come from the engine (HeatScale below — the result's
// `limit_core_c`, GET /settings `near_limit_margin_c`, and the lowest starting
// p50 in the result). Colours are kept in sync with --heat-* in tokens.css.

const PALETTE: [number, number, number][] = [
  [139, 150, 255],
  [178, 140, 255],
  [255, 178, 107],
  [255, 122, 89],
  [236, 56, 74],
]

/** Where the palette sits on the °C axis, all from engine numbers. */
export interface HeatScale {
  /** Lowest starting core estimate in the result (coolest colour). */
  floor: number
  /** Planning line − near band (amber). */
  near: number
  /** Planning line (red). */
  limit: number
}

/** °C positions of the five palette colours: floor, halfway to near, near, halfway to the line, the line. */
export function heatStops(scale: HeatScale): [number, [number, number, number]][] {
  const { floor, near, limit } = scale
  const xs = [floor, (floor + near) / 2, near, (near + limit) / 2, limit]
  return xs.map((x, i) => [x, PALETTE[i]])
}

const NEUTRAL: [number, number, number] = [170, 170, 182]

export function heatRgb(c: number, scale: HeatScale | null): [number, number, number] {
  if (!scale) return NEUTRAL
  const stops = heatStops(scale)
  if (c <= stops[0][0]) return stops[0][1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, a] = stops[i]
    const [t1, b] = stops[i + 1]
    if (c <= t1) {
      if (t1 <= t0) return b
      const k = (c - t0) / (t1 - t0)
      return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k)) as [number, number, number]
    }
  }
  return stops[stops.length - 1][1]
}

export function heatColor(c: number, scale: HeatScale | null, alpha = 1): string {
  const [r, g, b] = heatRgb(c, scale)
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`
}

export function cToF(c: number) {
  return c * 1.8 + 32
}

export function clockLabel(startHour: number, minute: number) {
  const totalMin = Math.round(startHour * 60 + minute)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${m.toString().padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}

export function mmss(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`
}

/** Chart y-range that shows every value and the planning line, with a little headroom. Display only. */
export function chartDomain(values: number[], marks: (number | null | undefined)[] = []): [number, number] {
  const all = [...values, ...marks.filter((m): m is number => m != null && Number.isFinite(m))].filter(Number.isFinite)
  if (!all.length) return [0, 1]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const pad = (hi - lo || 1) * 0.06
  return [lo - pad, hi + pad]
}

/** Round-number grid lines for a chart range (about five). Display only. */
export function niceTicks([lo, hi]: [number, number], target = 5): number[] {
  const span = hi - lo
  if (!(span > 0)) return []
  const mag = Math.pow(10, Math.floor(Math.log10(span / target)))
  const steps = [0.5, 1, 2, 2.5, 5, 10].map((m) => m * mag)
  const step = steps.reduce((best, s) => (Math.abs(span / s - target) < Math.abs(span / best - target) ? s : best))
  const out: number[] = []
  for (let t = Math.ceil(lo / step) * step; t < hi; t += step) out.push(Math.round(t / step) * step)
  return out
}
