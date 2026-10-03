import type { VoiceIntentName, VoiceSlots } from './engineApi'

// Eight scripted questions for testing "Ask Kelvin" (voice or text). For each: the intent it must route to, and the
// slots it must resolve. Drills are named by a pattern on the drill NAME (found on whatever plan is in use), athletes by
// first name on the roster — never by a hard-coded id. Run them from the panel's "Test…" menu or `npx vitest`.

export interface TestQuestion {
  q: string
  intent: VoiceIntentName
  /** The drill the question names, matched against the plan's drill names. */
  drill?: RegExp
  /** The athlete the question names (first name on the roster). */
  athlete?: string
  /** Other slots that must be resolved (change, gear, preset). No minutes: add_break leaves the length to the engine. */
  slots?: Partial<Omit<VoiceSlots, 'drill_id' | 'athlete_id'>>
  /** Language the guard must keep out of the reply. */
  mustNotSay?: RegExp
}

export const TEST_QUESTIONS: TestQuestion[] = [
  { q: 'Who crosses the planning line first in this practice?', intent: 'plan_summary' },
  { q: "What's the WBGT at 4 pm, and which FHSAA zone is that?", intent: 'field_conditions' },
  { q: 'How hot does Isaiah get?', intent: 'athlete_status', athlete: 'Isaiah' },
  { q: 'What if we drop the gassers?', intent: 'what_if', drill: /gassers/i, slots: { change: 'remove' } },
  { q: 'What if team period is helmets only?', intent: 'what_if', drill: /^team period$/i, slots: { change: 'gear', gear: 'helmet' } },
  { q: 'Fix the plan.', intent: 'optimize', slots: { preset: 'max_load' } },
  { q: 'Can you do it in six changes or fewer?', intent: 'optimize', slots: { preset: 'fewest_changes' } },
  {
    q: 'Is Devin safe to keep practicing?',
    intent: 'athlete_status',
    athlete: 'Devin',
    mustNotSay: /\b(safe|fine|okay|ok|cleared)\b/i,
  },
]
