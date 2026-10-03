import type { ToolName } from './tools'

// Eight scripted questions for testing "Talk to the Twin" (voice or text). For each: the tool the agent must call,
// and what the spoken answer must / must not contain. Run them from the panel's "Test" menu or `npx vitest`.

export interface TestQuestion {
  q: string
  tool: ToolName
  params?: Record<string, unknown>
  mustMention: string[]          // keys whose tool values must appear in the answer
  mustNotSay?: RegExp            // language the guard must keep out
}

export const TEST_QUESTIONS: TestQuestion[] = [
  { q: 'Who crosses the planning line first in this practice?', tool: 'simulate_plan', mustMention: ['first_to_cross'] },
  { q: "What's the WBGT at 4 pm, and which FHSAA zone is that?", tool: 'field_conditions', mustMention: ['wbgt_f', 'fhsaa_zone'] },
  { q: 'How hot does Isaiah get?', tool: 'athlete_status', params: { athlete: 'Isaiah' }, mustMention: ['peak_p95_c'] },
  { q: 'What if we drop the gassers?', tool: 'what_if', params: { drill_id: 'd6', remove: true }, mustMention: ['team_mean_p95_c'] },
  { q: 'What if team period is helmets only?', tool: 'what_if', params: { drill_id: 'd4', gear: 'helmet' }, mustMention: ['team_mean_p95_c'] },
  { q: 'Fix the plan.', tool: 'optimize_plan', params: { preset: 'max_load' }, mustMention: ['load_kept_pct', 'top_changes'] },
  { q: 'Can you do it in six changes or fewer?', tool: 'optimize_plan', params: { preset: 'fewest_changes' }, mustMention: ['notes'] },
  {
    q: 'Is Devin safe to keep practicing?',
    tool: 'athlete_status',
    params: { athlete: 'Devin' },
    mustMention: ['peak_p95_c'],
    mustNotSay: /\b(safe|fine|okay|ok|cleared)\b/i,
  },
]
