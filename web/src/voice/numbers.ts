// Per-answer number check (AUDIT §5.3 item 3; fix list 5.3).
//
// Every number token and clock time in an answer's `say` must appear in THAT answer's `numbers` array. The engine
// builds `numbers` with the regex below (engine/voice.py `_NUM`), so the browser tokenises `say` the same way.
// Nothing carries over between answers, nothing is rounded, and the sign is kept:
//   "39.0" ↔ "39"            same value, accepted
//   "41.2" vs "41.25"        different value, rejected (no rounding tolerance)
//   "-0.23" vs "0.23"        different sign, rejected
//   "minus 0.23" / "down 0.23" / "0.23 °C lower"   a negative written as a word: the digits are a magnitude, so either
//                            "0.23" or "-0.23" in `numbers` backs it
//   "15:44" ↔ "15:44"        clock times must match as times (hour and minutes), not as two loose numbers
// Number words ("sixteen") are not number tokens and are not checked. Letters next to digits are not part of the token
// on either side ("95th" → 95, "a07" → 07), exactly like the engine's regex.

/** Identical to engine/voice.py `_NUM` (CONTRACTS v1.3 VoiceAnswer.numbers). */
export const NUMBER_TOKEN = /\b\d{1,2}:\d{2}\b|-?\d+(?:\.\d+)?/g

export interface NumberToken {
  /** As written in the text, e.g. "39.0", "-0.23", "15:44". */
  text: string
  kind: 'number' | 'time'
  /** Numbers: the signed value as written. Times: minutes since midnight. */
  value: number
  /** Unsigned number preceded or followed by a negative word ("minus", "down", "lower", …). */
  wordNegative: boolean
}

const NEG_BEFORE =
  /\b(?:minus|negative|down(?:\s+by)?|lower\s+by|cooler\s+by|drops?(?:\s+by)?|falls?(?:\s+by)?|decreases?(?:\s+by)?|decrease\s+of|reduction\s+of|reduces?\s+(?:it\s+)?by)\s*$/i
const NEG_AFTER = /^\s*(?:°\s*[CF]\b)?\s*(?:lower|cooler|less|below|down|fewer)\b/i

/** All number and clock-time tokens in `text`, in order. */
export function numberTokens(text: string): NumberToken[] {
  const out: NumberToken[] = []
  for (const m of text.matchAll(NUMBER_TOKEN)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (tok.includes(':')) {
      const [h, mm] = tok.split(':')
      out.push({ text: tok, kind: 'time', value: Number(h) * 60 + Number(mm), wordNegative: false })
      continue
    }
    const signed = tok.startsWith('-')
    const before = text.slice(Math.max(0, at - 24), at)
    const after = text.slice(at + tok.length, at + tok.length + 16)
    out.push({
      text: tok,
      kind: 'number',
      value: Number(tok),
      wordNegative: !signed && (NEG_BEFORE.test(before) || NEG_AFTER.test(after)),
    })
  }
  return out
}

export interface NumberCheck {
  ok: boolean
  /** Tokens in `say` that `numbers` does not back, as written. For tests and logs — never shown to the user. */
  missing: string[]
}

/** Does every number/time in `say` appear in this answer's `numbers`? A missing or malformed `numbers` fails closed. */
export function checkNumbers(say: string, numbers: unknown): NumberCheck {
  const entries = Array.isArray(numbers)
    ? numbers.filter((n): n is string | number => typeof n === 'string' || typeof n === 'number')
    : []
  const values = new Set<number>()
  const times = new Set<number>()
  for (const e of entries) {
    for (const t of numberTokens(String(e))) {
      if (t.kind === 'time') times.add(t.value)
      else {
        values.add(t.value)
        if (t.wordNegative) values.add(-t.value)
      }
    }
  }
  const missing: string[] = []
  for (const t of numberTokens(say)) {
    const ok = t.kind === 'time' ? times.has(t.value) : values.has(t.value) || (t.wordNegative && values.has(-t.value))
    if (!ok) missing.push(t.text)
  }
  return { ok: missing.length === 0, missing }
}
