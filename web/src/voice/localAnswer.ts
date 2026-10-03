import type { ToolName } from './tools'

// Deterministic text fallback when no ElevenLabs agent is configured or the network is down: route the question to one
// tool by keywords and answer with the tool's own guarded `say` sentence (so every number still comes from a tool).
// Drill names map to the fixture plan's drill ids (fixtures/plan.json).

const DRILLS: [RegExp, string][] = [
  [/gasser|condition|sprint/i, 'd6'],
  [/special/i, 'd5'],
  [/team period|team/i, 'd4'],
  [/inside run/i, 'd3'],
  [/individual|indy/i, 'd2'],
  [/warm/i, 'd1'],
]

export interface Route { tool: ToolName; params: Record<string, unknown> }

export function route(q: string, athleteNames: string[] = []): Route | null {
  const t = q.toLowerCase()
  const drill = DRILLS.find(([re]) => re.test(q))?.[1]
  if (/what if|drop|remove|cut|skip|helmet|no pads|shorts|in the shade|add a break|extra break/.test(t) && drill) {
    if (/add a break|extra break|break after/.test(t)) return { tool: 'what_if', params: { add_break_after: drill, minutes: 4 } }
    if (/drop|remove|cut|skip/.test(t)) return { tool: 'what_if', params: { drill_id: drill, remove: true } }
    if (/helmet/.test(t)) return { tool: 'what_if', params: { drill_id: drill, gear: 'helmet' } }
    if (/no pads|shorts/.test(t)) return { tool: 'what_if', params: { drill_id: drill, gear: 'none' } }
    if (/shade/.test(t)) return { tool: 'what_if', params: { drill_id: drill, shade: true } }
  }
  if (/fix|optimi[sz]e|rewrite|make (the )?plan|change(s)? (do|would)/.test(t) || /fewer|fewest|six changes|6 changes/.test(t))
    return { tool: 'optimize_plan', params: { preset: /fewer|fewest|six|6 /.test(t) ? 'fewest_changes' : 'max_load' } }
  const name = athleteNames.find((n) => t.includes(n.toLowerCase()))
  if (name) return { tool: 'athlete_status', params: { athlete: name } }
  if (/wbgt|zone|weather|forecast|humid|temperature out|conditions/.test(t)) return { tool: 'field_conditions', params: {} }
  if (/who|first|cross|over the line|how many|plan/.test(t)) return { tool: 'simulate_plan', params: {} }
  return null
}
