import type { ContractGear, ContractIntensity, PracticePlan } from '../data/llmPlan'
import type { VoiceChange, VoiceIntent, VoiceIntentName, VoiceSlots } from './engineApi'

// Local intent router for TYPED questions when the engine's intent service is unavailable (no GEMINI_API_KEY → 503, or
// the engine/network is down). It does what Gemini does on /voice/intent and nothing more: text → {intent, slots}.
// The engine still runs the tool and writes every number (/voice/answer).
//
//  * Drill names resolve against the drills of the plan passed in (the plan on screen) — no drill-id table.
//  * Athlete names resolve against the roster passed in — no name table.
//  * No default minutes: add_break leaves duration_min out so the engine picks the FHSAA break length for that hour;
//    a duration is only filled when the coach typed one ("make team period 15 minutes").
//  * Anything it can't match is returned in `unresolved` (asked back, not guessed); no match at all → "unknown".

export interface RosterName {
  id: string
  name: string
}

export const LOCAL_ROUTER_MODEL = 'local-router'
export const LOCAL_ROUTER_LABEL = 'intent routed in the browser from typed text (no AI) — numbers come from the engine'

// ── text helpers ──
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'in', 'on', 'at', 'to', 'for', 'or', 'we', 'is', 'it'])
// Words that appear in many drill names or as ordinary verbs: they count, but less than a distinctive word.
const GENERIC = new Set(['run', 'period', 'drill', 'work', 'practice', 'session', 'time', 'break', 'water', 'block'])

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\(fictional\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

/** Crude plural strip so "gassers" ↔ "gasser", "teams" ↔ "team", "helmets" ↔ "helmet". */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

/** Stemmed words of the text, plus joined neighbours so "warm up" / "cool-down" match "warmup" / "cooldown". */
function textTerms(text: string): Set<string> {
  const w = words(text)
  const out = new Set<string>()
  w.forEach((x, i) => {
    out.add(stem(x))
    out.add(x)
    if (i + 1 < w.length) out.add(stem(x + w[i + 1]))
  })
  return out
}

type Match<T> = { found: T } | { ambiguous: T[] } | { none: true }

/** The plan drill a phrase names. Score = weighted share of the drill's name words present in the phrase. */
export function resolveDrill(phrase: string, plan: PracticePlan): Match<PracticePlan['drills'][number]> {
  const terms = textTerms(phrase)
  const byId = plan.drills.filter((d) => terms.has(d.id.toLowerCase()))
  if (byId.length === 1) return { found: byId[0] }
  const scored = plan.drills
    .map((d) => {
      const name = [...new Set(words(d.name).filter((w) => !STOP.has(w)).map(stem))]
      const weight = (w: string) => (GENERIC.has(w) ? 0.4 : 1)
      const total = name.reduce((s, w) => s + weight(w), 0)
      const hit = name.filter((w) => terms.has(w))
      return { d, score: total ? hit.reduce((s, w) => s + weight(w), 0) / total : 0, n: hit.length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.n - a.n)
  if (!scored.length) return { none: true }
  const top = scored.filter((x) => x.score === scored[0].score && x.n === scored[0].n)
  return top.length === 1 ? { found: top[0].d } : { ambiguous: top.map((x) => x.d) }
}

/** The roster athlete a question names (any word of the name, or the id). Two different athletes → ambiguous. */
export function resolveAthlete(text: string, roster: RosterName[]): Match<RosterName> {
  const w = new Set(words(text))
  const hits = roster.filter((a) => w.has(a.id.toLowerCase()) || words(a.name).some((n) => n.length > 1 && w.has(n)))
  if (hits.length === 1) return { found: hits[0] }
  return hits.length ? { ambiguous: hits } : { none: true }
}

// ── intent cues ──
const STRONG_WHAT_IF = /\bwhat (?:if|happens if|about if)\b|\bsuppose\b|\b(?:drop|remove|cut|skip|scrap|lose|move|add|insert|shorten|lengthen|extend)\b/
const OPTIMIZE =
  /\b(?:fix|optimi[sz]e|rewrite|redo|re-?plan|reschedule)\b|\bmake (?:the |this |it |our )?(?:plan )?(?:work|fit|better|cooler)\b|\bget (?:everyone|them|us) under\b|\bfewe(?:r|st)\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) changes\b/
const FEWEST = /\bfewe(?:r|st)\b|\bleast\b|\bminimal\b|\bminimum\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten) changes\b/
const FIELD = /\b(?:wbgt|fhsaa|zones?|weather|forecast|humid(?:ity)?|wind|heat index|conditions|outside|sun)\b|\bhow hot is it\b/
const SUMMARY =
  /\b(?:who|first|cross(?:es|ing)?|line|how many|plan|practice|summary|overall|team|everyone|roster|hottest|anyone|athletes)\b/

interface Change {
  change: VoiceChange
  slots: VoiceSlots
  /** Where to look for the drill name. */
  phrase: string
}

function detectChange(t: string, plan: PracticePlan): Change | null {
  const minutes = t.match(/\b(\d{1,3})\s*(?:min|mins|minute|minutes)\b/)
  if (/\b(?:add|insert|put in|another|extra)\b[^.?!]*\bbreak\b|\bbreak after\b/.test(t)) {
    const after = t.match(/\bafter\s+(.+)$/)
    const phrase = (after ? after[1] : t).replace(/\b(?:water|extra|another|break|add|insert)\b/g, ' ')
    return { change: 'add_break', slots: {}, phrase } // no duration_min: the engine uses the FHSAA break length
  }
  if (minutes && /\b(?:shorten|lengthen|extend|make|cut|trim|only|just|to|is|was|be|run)\b/.test(t))
    return { change: 'duration', slots: { duration_min: Number(minutes[1]) }, phrase: t.replace(minutes[0], ' ') }
  if (/\b(?:drop|remove|cut|skip|scrap|lose|get rid of|take out)\b/.test(t)) return { change: 'remove', slots: {}, phrase: t }
  if (/\bmove\b/.test(t)) {
    if (/\b(?:start|beginning|first)\b/.test(t)) return { change: 'move', slots: { move_to: 0 }, phrase: t }
    if (/\b(?:end|last)\b/.test(t)) return { change: 'move', slots: { move_to: Math.max(0, plan.drills.length - 1) }, phrase: t }
  }
  const gear: ContractGear | null = /\bno pads\b|\bshorts\b|\bno gear\b|\bt-?shirts?\b|\bno helmets?\b/.test(t)
    ? 'none'
    : /\bshells\b|\bshoulder pads\b|\bhalf pads\b/.test(t)
      ? 'helmet_shoulder_pads'
      : /\bfull pads\b/.test(t)
        ? 'full_pads'
        : /\bhelmets?\b/.test(t)
          ? 'helmet'
          : null
  if (gear) return { change: 'gear', slots: { gear }, phrase: t }
  if (/\bshade\b|\bunder (?:the |a )?tent\b/.test(t)) return { change: 'shade', slots: { shade: true }, phrase: t }
  const intensity: ContractIntensity | null = /\bwalk-?\s?through\b|\bhalf speed\b/.test(t) ? 'light' : null
  if (intensity) return { change: 'intensity', slots: { intensity }, phrase: t }
  return null
}

/** Best-effort quote of what the coach called the drill, for "couldn't match …". */
function drillPhrase(t: string): string {
  const m =
    t.match(/\b(?:drop|remove|cut|skip|scrap|lose|move|shorten|lengthen|extend|after)\s+(?:the\s+)?([a-z][a-z0-9 '-]*?)(?=\s+(?:to|in|from|is|are|with|for)\b|[?.!,]|$)/) ??
    t.match(/\bwhat (?:if|about)\s+(?:we\s+)?(?:the\s+)?([a-z][a-z0-9 '-]*?)(?=\s+(?:is|are|was|were|in|with|goes|went)\b|[?.!,]|$)/)
  return (m?.[1] ?? '').trim() || 'that drill'
}

function intent(text: string, name: VoiceIntentName, slots: VoiceSlots = {}, unresolved: string[] = []): VoiceIntent {
  return { transcript: text, intent: name, slots, unresolved, labels: [LOCAL_ROUTER_LABEL], model: LOCAL_ROUTER_MODEL }
}

/** Typed question → VoiceIntent, resolved against the plan on screen and the roster. */
export function routeLocal(text: string, plan: PracticePlan, roster: RosterName[]): VoiceIntent {
  const t = text.toLowerCase().replace(/[’']/g, "'")

  // 1) A what-if edit to one drill of THIS plan.
  const ch = detectChange(t, plan)
  if (ch) {
    const m = resolveDrill(ch.phrase, plan)
    if ('found' in m) return intent(text, 'what_if', { drill_id: m.found.id, change: ch.change, ...ch.slots })
    if (STRONG_WHAT_IF.test(t)) {
      const what = 'ambiguous' in m ? `${drillPhrase(t)} (could be ${m.ambiguous.map((d) => d.name).join(' or ')})` : drillPhrase(t)
      return intent(text, 'unknown', {}, [what])
    }
  }

  // 2) Rewrite the plan.
  if (OPTIMIZE.test(t)) return intent(text, 'optimize', { preset: FEWEST.test(t) ? 'fewest_changes' : 'max_load' })

  // 3) One athlete.
  const a = resolveAthlete(t, roster)
  if ('found' in a) return intent(text, 'athlete_status', { athlete_id: a.found.id })
  if ('ambiguous' in a) return intent(text, 'unknown', {}, [`${a.ambiguous.map((x) => x.name.replace(/\s*\(fictional\)/i, '')).join(' or ')} (one athlete at a time)`])

  // 4) Field conditions, 5) the plan as a whole.
  if (FIELD.test(t)) return intent(text, 'field_conditions')
  if (SUMMARY.test(t)) return intent(text, 'plan_summary')
  return intent(text, 'unknown')
}
