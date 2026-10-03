// Centripetal-free, uniform Catmull-Rom → cubic Bézier. Gives smooth curves
// through every sample without overshooting badly on the gentle physiological
// curves we draw. `tension` 0.5 is the classic Catmull-Rom; lower is tighter.

export type Pt = readonly [number, number]

export function splinePath(points: Pt[], tension = 0.5): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`
  const t = tension / 3
  let d = `M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1[0] + (p2[0] - p0[0]) * t
    const c1y = p1[1] + (p2[1] - p0[1]) * t
    const c2x = p2[0] - (p3[0] - p1[0]) * t
    const c2y = p2[1] - (p3[1] - p1[1]) * t
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
  }
  return d
}

/** Closed band between an upper and lower spline (upper left→right, lower right→left). */
export function bandPath(upper: Pt[], lower: Pt[], tension = 0.5): string {
  if (upper.length < 2) return ''
  const top = splinePath(upper, tension)
  const back = splinePath([...lower].reverse(), tension).replace(/^M/, 'L')
  return `${top}${back}Z`
}

/** Thin a dense series down to roughly `target` points, always keeping the ends. */
export function downsample<T>(arr: T[], target: number): { value: T; index: number }[] {
  if (arr.length <= target) return arr.map((value, index) => ({ value, index }))
  const step = (arr.length - 1) / (target - 1)
  const out: { value: T; index: number }[] = []
  for (let i = 0; i < target; i++) {
    const index = Math.round(i * step)
    out.push({ value: arr[index], index })
  }
  return out
}
