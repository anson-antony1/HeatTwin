// Number provenance: the agent may only speak numbers that a tool returned in this conversation.
// Every tool result is added to a ledger; every agent reply is checked against it.

const NUM = /-?\d+(?:[.,]\d+)?/g
const TIME = /\b(\d{1,2}):(\d{2})\b/g

/** Equivalent spellings of a number token: "39.0" ↔ "39"; "0.90" ↔ "0.9". */
export function forms(token: string): string[] {
  const out = new Set<string>([token])
  const n = Number(token.replace(',', '.'))
  if (Number.isFinite(n)) {
    for (const v of [n, Math.abs(n)]) {  // a sign is usually spoken as "down"/"lower", not "minus"
      out.add(String(v))
      out.add(v.toFixed(1))
      out.add(v.toFixed(2))
    }
  }
  return [...out]
}

/** "15:44" → ["15:44", "3:44"] (24 h and 12 h clock). */
function timeForms(h: number, mm: string): string[] {
  return h > 12 ? [`${h}:${mm}`, `${h - 12}:${mm}`] : [`${h}:${mm}`]
}

export class NumberLedger {
  private seen = new Set<string>()

  /** Record every number and clock time appearing in a tool result. */
  add(payload: unknown): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    for (const m of text.matchAll(TIME)) for (const t of timeForms(Number(m[1]), m[2])) this.seen.add(t)
    for (const m of text.match(NUM) ?? []) for (const f of forms(m)) this.seen.add(f)
  }

  /** Numbers or times in ``text`` that no tool returned. List markers "1)" … "3)" are ignored. */
  unsupported(text: string): string[] {
    const bad: string[] = []
    const rest = text.replace(TIME, (t, h: string, mm: string) => {
      if (!this.seen.has(`${Number(h)}:${mm}`)) bad.push(t)
      return ' '
    })
    for (const m of rest.matchAll(/(-?\d+(?:[.,]\d+)?)(\))?/g)) {
      const tok = m[1]
      if (m[2] === ')' && Number(tok) <= 3) continue
      if (!forms(tok).some((f) => this.seen.has(f))) bad.push(tok)
    }
    return bad
  }

  reset(): void {
    this.seen.clear()
  }
}
