import { ESTIMATE_LABEL } from './config'
import { engineApi, type SimulationResult, type WhatIfChange } from './engineApi'
import type { NumberLedger } from './numbers'

// Client tools for the ElevenLabs agent ("Talk to the Twin"). Names and parameters must match agent/agent_config.json.
// Each returns a compact JSON string of NUMBERS from the engine plus a `say` sentence the engine already guarded.
// Every result is added to the NumberLedger so the panel can flag any number the agent speaks that no tool returned.

export type ToolName = 'simulate_plan' | 'optimize_plan' | 'what_if' | 'athlete_status' | 'field_conditions'

function firstCrossers(res: SimulationResult, k = 3) {
  return res.athletes
    .filter((a) => a.first_cross_min != null)
    .sort((a, b) => (a.first_cross_min ?? 0) - (b.first_cross_min ?? 0))
    .slice(0, k)
    .map((a) => ({ name: (a.name ?? a.id).replace(' (fictional)', ''), minute: a.first_cross_min, peak_p95_c: a.peak_core_c_p95 }))
}

export function makeTools(ledger: NumberLedger, fetchImpl?: typeof fetch) {
  const done = (o: Record<string, unknown>) => {
    const out = JSON.stringify({ ...o, label: ESTIMATE_LABEL })
    ledger.add(out)
    return out
  }

  const tools: Record<ToolName, (p: Record<string, unknown>) => Promise<string>> = {
    simulate_plan: async () => {
      const r = await engineApi.simulate(fetchImpl)
      const over = r.athletes.filter((a) => a.status === 'over_limit').length
      const first = firstCrossers(r)
      return done({
        athletes: r.athletes.length,
        over_limit: over,
        limit_c: r.limit_core_c,
        max_p95_c: Math.max(...r.athletes.map((a) => a.peak_core_c_p95)),
        first_to_cross: first,
        fhsaa_violations: r.fhsaa_violations.length,
        say: `${over} of ${r.athletes.length} athletes are estimated over the ${r.limit_core_c} °C planning line. First: ${first
          .map((f) => `${f.name} at minute ${f.minute}`)
          .join(', ')}. ${r.fhsaa_violations.length} FHSAA issues in the plan.`,
      })
    },
    optimize_plan: async (p) => {
      const preset = p.preset === 'fewest_changes' ? 'fewest_changes' : 'max_load'
      const r = await engineApi.optimize(preset, fetchImpl)
      const over = r.optimized.athletes.filter((a) => a.status === 'over_limit').length
      const notes = (r.labels ?? []).filter((l) => l.includes('fewest_changes:') || l.includes('least-bad'))
      return done({
        feasible: r.feasible,
        load_kept_pct: r.load_kept_pct,
        changes: r.changes.length,
        over_limit_after: over,
        max_p95_after_c: Math.max(...r.optimized.athletes.map((a) => a.peak_core_c_p95)),
        fhsaa_violations_after: r.optimized.fhsaa_violations.length,
        top_changes: r.top_changes ?? [],
        notes,
        say: `${notes.length ? notes.join('. ') + '. ' : ''}${r.top_changes_text ?? ''} ${r.load_kept_pct}% of the training load kept with ${r.changes.length} changes; ${over} athletes over the line afterwards.`,
      })
    },
    what_if: async (p) => {
      const r = await engineApi.whatIf(p as unknown as WhatIfChange, fetchImpl)
      return done({ before: r.before, after: r.after, delta_team_mean_p95_c: r.delta_team_mean_p95_c, say: r.say })
    },
    athlete_status: async (p) => {
      const r = await engineApi.athleteStatus(String(p.athlete ?? p.athlete_id ?? ''), fetchImpl)
      return done({ ...r })
    },
    field_conditions: async () => {
      const r = await engineApi.fieldConditions(fetchImpl)
      return done({ hours: r.hours, sources: r.sources, say: r.say })
    },
  }
  return tools
}
