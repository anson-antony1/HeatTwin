import { describe, expect, it } from 'vitest'
import { NumberLedger } from '../numbers'
import { route } from '../localAnswer'
import { TEST_QUESTIONS } from '../testQuestions'
import { makeTools } from '../tools'

describe('number ledger', () => {
  it('accepts numbers a tool returned, in equivalent spellings, and flags others', () => {
    const l = new NumberLedger()
    l.add({ limit_c: 39.0, team_mean_p95_c: 40.87, time: '15:44', pct: 75.3 })
    expect(l.unsupported('Line is 39 °C; average peak 40.87; at 3:44 and 15:44; 75.3% kept')).toEqual([])
    expect(l.unsupported('Peak is 41.2 °C')).toEqual(['41.2'])
    expect(l.unsupported('1) first 2) second')).toEqual([])
  })
})

describe('local routing of the 8 scripted questions', () => {
  const names = ['Isaiah', 'Devin', 'Caleb']
  for (const t of TEST_QUESTIONS) {
    it(t.q, () => {
      const r = route(t.q, names)
      expect(r?.tool).toBe(t.tool)
      if (t.params) expect(r?.params).toMatchObject(t.params)
    })
  }
})

describe('client tools', () => {
  it('return engine numbers + say, and feed the ledger', async () => {
    const fake: typeof fetch = async (input) => {
      const url = String(input)
      const body = url.includes('/what_if')
        ? { before: { team_mean_p95_c: 41.1 }, after: { team_mean_p95_c: 40.87 }, delta_team_mean_p95_c: -0.23, say: 'goes from 41.1 to 40.87 °C' }
        : {}
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const ledger = new NumberLedger()
    const tools = makeTools(ledger, fake)
    const out = JSON.parse(await tools.what_if({ drill_id: 'd6', remove: true }))
    expect(out.delta_team_mean_p95_c).toBe(-0.23)
    expect(out.label).toBe('estimate — planning only')
    expect(ledger.unsupported('from 41.1 to 40.87 °C, down 0.23')).toEqual([])
  })
})
