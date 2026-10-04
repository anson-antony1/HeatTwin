import type { PlanDraft, PracticePlan } from './llmPlan'

// The grey "how it was understood" line under the coach's words. Built from the draft's structured drills (names and
// minutes from the plan itself), never from Gemini's prose, so no AI-written number reaches the screen.

const INTENSITY: Record<string, string> = { rest: 'rest', light: 'light', moderate: 'moderate', hard: 'hard', max: 'max' }
const fmt = (m: number) => `${Math.round(m * 10) / 10} min`

/** Who interpreted the words: Gemini, or the offline parser. */
export function interpreterName(draft: Pick<PlanDraft, 'model'>): string {
  return /gemini/i.test(draft.model ?? '') ? 'Gemini' : 'Offline parser'
}

/** One short line per change from `before` to the draft; a new plan lists its drills. */
export function interpretation(draft: Pick<PlanDraft, 'plan'>, before: PracticePlan | null): string[] {
  const after = draft.plan.drills
  if (!before) {
    if (!after.length) return ['No drills understood yet']
    return [after.map((d) => `${d.name} ${fmt(d.duration_min)}${d.is_break ? '' : ` · ${INTENSITY[d.intensity] ?? d.intensity}`}`).join('  ·  ')]
  }
  const key = (n: string) => n.trim().toLowerCase()
  const old = new Map(before.drills.map((d) => [key(d.name), d]))
  const now = new Map(after.map((d) => [key(d.name), d]))
  const out: string[] = []
  for (const d of after) {
    const o = old.get(key(d.name))
    if (!o) {
      out.push(`Add ${d.name} · ${fmt(d.duration_min)}${d.is_break ? '' : ` · ${INTENSITY[d.intensity] ?? d.intensity}`}`)
      continue
    }
    if (o.duration_min !== d.duration_min) out.push(`${d.name} ${fmt(o.duration_min)} → ${fmt(d.duration_min)}`)
    if (o.intensity !== d.intensity) out.push(`${d.name} ${o.intensity} → ${d.intensity}`)
    if (o.gear !== d.gear) out.push(`${d.name} gear ${o.gear.replace(/_/g, ' ')} → ${d.gear.replace(/_/g, ' ')}`)
  }
  for (const o of before.drills) if (!now.has(key(o.name))) out.push(`Remove ${o.name}`)
  const order = (ds: { name: string }[]) => ds.map((d) => key(d.name)).filter((n) => old.has(n) && now.has(n)).join('|')
  if (!out.length && order(before.drills) !== order(after)) out.push('Reorder drills')
  return out.length ? out : ['No change to the plan']
}
