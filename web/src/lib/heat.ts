// Thermal palette. Cool lavender at baseline → amber at the watch line →
// coral red at the alert line. Kept in sync with --heat-* in tokens.css.

const STOPS: [number, [number, number, number]][] = [
  [37.0, [139, 150, 255]],
  [37.7, [178, 140, 255]],
  [38.3, [255, 178, 107]],
  [38.8, [255, 122, 89]],
  [39.3, [236, 56, 74]],
]

export function heatRgb(c: number): [number, number, number] {
  if (c <= STOPS[0][0]) return STOPS[0][1]
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, a] = STOPS[i]
    const [t1, b] = STOPS[i + 1]
    if (c <= t1) {
      const k = (c - t0) / (t1 - t0)
      return [0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * k)) as [number, number, number]
    }
  }
  return STOPS[STOPS.length - 1][1]
}

export function heatColor(c: number, alpha = 1): string {
  const [r, g, b] = heatRgb(c)
  return alpha === 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`
}

export const HEAT_STOPS = STOPS

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
