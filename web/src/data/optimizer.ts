import type { Athlete, Drill, WeatherHour } from './types'
import { THRESHOLDS, zoneFor } from './constants'
import { peakOf, simulate, totalMinutes, wbgtAt } from './model'

// Placeholder for engine/optimizer.py. A greedy pass that applies the same
// kinds of moves the real search will (reorder, insert breaks, change gear,
// sit one athlete out of one block) so the Plan view can show a believable
// before/after. Swap for the /optimize response when it exists.

/** Per-athlete heat factor learned from previous sessions (what the plan uses). */
export const PRIOR_FACTOR: Record<string, number> = {
  a01: 1.27, a02: 1.06, a03: 1.03, a04: 1.01, a05: 0.97, a06: 1.0, a07: 1.02, a08: 0.98,
  a09: 0.96, a10: 0.98, a11: 0.95, a12: 1.0, a13: 0.98, a14: 0.96, a15: 0.93, a16: 1.05,
}

export type ChangeKind = 'reorder' | 'break' | 'gear' | 'trim' | 'sit-out'

export interface PlanChange {
  kind: ChangeKind
  text: string
}

export interface PlanResult {
  plan: Drill[]
  /** athleteId → drillIds the athlete sits out of. */
  sitOuts: Record<string, string[]>
  changes: PlanChange[]
  loadKept: number
}

export function trainingLoad(plan: Drill[]): number {
  return plan.filter((d) => d.kind !== 'break').reduce((s, d) => s + d.met * d.minutes, 0)
}

/** Plan with an athlete's sat-out drills turned into rest, for simulation. */
export function planFor(plan: Drill[], sitOuts: string[] = []): Drill[] {
  if (!sitOuts.length) return plan
  return plan.map((d) => (sitOuts.includes(d.id) ? { ...d, met: 1.6, kind: 'break' as const } : d))
}

export function forecastRoster(
  roster: Athlete[],
  plan: Drill[],
  forecast: WeatherHour[],
  startHour: number,
  sitOuts: Record<string, string[]> = {},
): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const a of roster) {
    out[a.id] = simulate(a, planFor(plan, sitOuts[a.id]), forecast, startHour, PRIOR_FACTOR[a.id] ?? 1)
  }
  return out
}

export interface Violation {
  text: string
}

export function checkRules(plan: Drill[], forecast: WeatherHour[], startHour: number): Violation[] {
  const out: Violation[] = []
  const total = totalMinutes(plan)
  let peakWbgt = 0
  for (let m = 0; m < total; m += 5) peakWbgt = Math.max(peakWbgt, wbgtAt(forecast, startHour + m / 60))
  const zone = zoneFor(peakWbgt)
  if (zone.maxPracticeMin != null && total > zone.maxPracticeMin) {
    out.push({ text: `Runs ${total} min — ${zone.label.toLowerCase()} zone allows ${zone.maxPracticeMin}` })
  }
  const breaks = plan.filter((d) => d.kind === 'break').length
  const needed = Math.ceil((zone.breaksPerHour * total) / 60)
  if (breaks < needed) out.push({ text: `${breaks} breaks scheduled — zone needs ${needed}` })
  if (zone.id === 'red' && plan.some((d) => d.gear === 'full' && d.kind !== 'break')) {
    out.push({ text: 'Full pads in a red-zone hour — helmets & shells only' })
  }
  return out
}

let breakSeq = 0
const newBreak = (): Drill => ({
  id: `b${++breakSeq}`,
  name: 'Water break',
  kind: 'break',
  minutes: 3,
  met: 1.4,
  gear: 'shells',
})

export function optimize(
  roster: Athlete[],
  original: Drill[],
  forecast: WeatherHour[],
  startHour: number,
): PlanResult {
  const changes: PlanChange[] = []
  let plan = original.filter((d) => d.kind !== 'break').map((d) => ({ ...d }))

  // 1. Hardest block early, while cores are lowest.
  const condIdx = plan.findIndex((d) => d.kind === 'conditioning')
  if (condIdx > 1) {
    const [cond] = plan.splice(condIdx, 1)
    plan.splice(1, 0, cond)
    changes.push({ kind: 'reorder', text: `${cond.name} moved to minute ${plan[0].minutes} — before cores climb` })
  }

  // 2. Red zone: helmets & shells only.
  let geared = 0
  plan = plan.map((d) => {
    if (d.gear === 'full') {
      geared++
      return { ...d, gear: 'shells' as const }
    }
    return d
  })
  if (geared) changes.push({ kind: 'gear', text: `${geared} periods dropped from full pads to shells` })

  // 3. Fit the zone's limits: total time, and N breaks an hour. Work out the
  //    working-minute budget, trim the longest periods to fit it, then lay the
  //    breaks in evenly, splitting a period where a break lands mid-drill.
  const limit = 120
  const breakMin = 3
  const breaksNeeded = Math.ceil((4 * limit) / 60)
  const budget = limit - breaksNeeded * breakMin
  let over = totalMinutes(plan) - budget
  if (over > 0) {
    const trimmable = [...plan]
      .filter((d) => d.kind === 'team' || d.kind === 'individual')
      .sort((a, b) => b.minutes - a.minutes)
    const trimmed: string[] = []
    for (const d of trimmable) {
      if (over <= 0) break
      const cut = Math.min(over, Math.floor(d.minutes * 0.3))
      d.minutes -= cut
      over -= cut
      trimmed.push(`${d.name} −${cut}`)
    }
    changes.push({ kind: 'trim', text: `Trimmed to fit the ${limit}-min limit: ${trimmed.join(', ')} min` })
  }

  const working = totalMinutes(plan)
  const every = working / (breaksNeeded + 2) // a little tight, snapping stretches gaps
  const withBreaks: Drill[] = []
  const snap = 4 // place a break at a drill boundary if one is this close
  let elapsed = 0
  let nextAt = every
  let placed = 0
  plan.forEach((d, i) => {
    let left = d.minutes
    let part = 0
    // Split only when the break would otherwise land well inside the drill.
    while (placed < breaksNeeded && elapsed + left > nextAt + snap) {
      const take = Math.max(snap, Math.round(nextAt - elapsed))
      withBreaks.push({ ...d, id: `${d.id}-${part++}`, minutes: take })
      left -= take
      elapsed += take
      withBreaks.push(newBreak())
      placed++
      nextAt = elapsed + every
    }
    withBreaks.push({ ...d, id: part ? `${d.id}-${part}` : d.id, minutes: left })
    elapsed += left
    if (placed < breaksNeeded && elapsed >= nextAt - snap && i < plan.length - 1) {
      withBreaks.push(newBreak())
      placed++
      nextAt = elapsed + every
    }
  })
  plan = withBreaks
  changes.push({
    kind: 'break',
    text: `${placed} water breaks, one every ~${Math.round(every)} working min (was ${original.filter((d) => d.kind === 'break').length})`,
  })

  // 5. Anyone still forecast over the line sits out the hottest block.
  const sitOuts: Record<string, string[]> = {}
  for (const a of roster) {
    const f = simulate(a, plan, forecast, startHour, PRIOR_FACTOR[a.id] ?? 1)
    if (peakOf(f).value >= THRESHOLDS.alertC - 0.1) {
      const hottest = [...plan].filter((d) => d.kind !== 'break').sort((x, y) => y.met - x.met)[0]
      sitOuts[a.id] = [hottest.id]
      changes.push({ kind: 'sit-out', text: `${a.name} rotates out of ${hottest.name.toLowerCase()}` })
    }
  }

  return {
    plan,
    sitOuts,
    changes,
    loadKept: trainingLoad(plan) / trainingLoad(original),
  }
}
