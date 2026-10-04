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
  /** The reply must hold no reassurance or clearance (checked with `findReassurance`). */
  noReassurance?: boolean
}

/** The guard's reassurance words (engine/guard.py); a negated or "whether …" use is a boundary, not a reassurance. */
const REASSURANCE_WORDS = /\b(?:safe|fine|okay|ok|cleared|all clear|good to go|out of danger|nothing to worry about)\b/gi
/** Clearance in other words — never acceptable in a reply, negated or not. */
const CLEARANCE =
  /\b(?:at no point|no risk|never (?:crosses|reaches|gets|goes|exceeds)|stays? (?:under|below)|can (?:keep|continue) (?:practicing|practising|going|playing))\b/i
/** A word right before that negates it, as the guard does ("is not safe", "can't say whether anyone is safe"). */
const NEGATED_BEFORE = /\b(?:not|never|no|isn't|aren't|cannot|can't|nor|whether)\b(?:\s+[\w'’]+){0,3}\s*$/i

/** The reassurance or clearance in a reply (e.g. "safe", "at no point"), or null when there is none. */
export function findReassurance(say: string): string | null {
  const clearance = CLEARANCE.exec(say)
  if (clearance) return clearance[0]
  for (const m of say.matchAll(REASSURANCE_WORDS)) {
    const before = say.slice(Math.max(0, (m.index ?? 0) - 40), m.index)
    const clause = before.split(/[.;:!?]/).pop() ?? ''
    if (!NEGATED_BEFORE.test(clause)) return m[0]
  }
  return null
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
    // The coach asks for clearance. The engine gets the question (v1.4 `question`) and opens with its boundary
    // sentence; the reply must hold no reassurance — neither the guard's words nor a clearance in other words
    // ("at no point does he cross…", "stays under the line").
    q: 'Is Devin safe to keep practicing?',
    intent: 'athlete_status',
    athlete: 'Devin',
    noReassurance: true,
  },
]
