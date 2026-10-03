import { describe, expect, it } from 'vitest'
import { engineApi } from '../engineApi'
import { route } from '../localAnswer'
import { NumberLedger } from '../numbers'
import { TEST_QUESTIONS } from '../testQuestions'
import { makeTools } from '../tools'

// Live check of the 8 scripted questions against a running engine (text path: route → tool → guarded `say`).
// Runs only when VITE_HEATTWIN_LIVE=1 (and VITE_ENGINE_URL points at the engine).
describe.runIf(import.meta.env.VITE_HEATTWIN_LIVE === '1')('scripted questions against the live engine', () => {
  const ledger = new NumberLedger()
  const tools = makeTools(ledger)
  let names: string[] = []
  for (const t of TEST_QUESTIONS) {
    it(t.q, async () => {
      if (!names.length) names = (await engineApi.simulate()).athletes.map((a) => (a.name ?? a.id).replace(' (fictional)', ''))
      const r = route(t.q, names)!
      expect(r.tool).toBe(t.tool)
      const out = JSON.parse(await tools[r.tool](r.params))
      for (const k of t.mustMention) expect(JSON.stringify(out)).toContain(`"${k}"`)
      const say = String(out.say)
      const g = await engineApi.guard(say)
      expect(g.ok).toBe(true)
      expect(ledger.unsupported(say)).toEqual([])
      if (t.mustNotSay) expect(say).not.toMatch(t.mustNotSay)
      console.log(`Q: ${t.q}\n   → ${r.tool}: ${say}`)
    }, 60000)
  }
})
