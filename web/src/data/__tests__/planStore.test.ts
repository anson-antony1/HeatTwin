import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemoInputs, OptimizeResult, RosterAthlete } from '../engineApi'
import type { PlanDraft, PracticePlan } from '../llmPlan'
import { fmtCore } from '../../lib/format'
import { PLAN, replay, sim, WEATHER } from './helpers'

// The stores against a mocked engine (fetch). Fresh modules per test: the stores are module singletons.

const ROSTER: RosterAthlete[] = [
  { id: 'a01', name: 'Marcus (fictional)', position: 'OL', height_m: 1.88, mass_kg: 125, age_yr: 17, sex: 'male', acclimatization_day: 5 },
  { id: 'a02', name: 'Devin (fictional)', position: 'OL', height_m: 1.9, mass_kg: 132, age_yr: 17, sex: 'male', acclimatization_day: 2 },
]
const INPUTS: DemoInputs = { plan: PLAN, roster: ROSTER, weather: WEATHER, labels: ['estimate — planning only'], synthetic: { plan: true, roster: true, weather: false } }
const OPT_PLAN: PracticePlan = { ...PLAN, drills: [...PLAN.drills, { ...PLAN.drills[1], id: 'b2' }] }
const OPT: OptimizeResult = {
  original: sim(),
  optimized: sim({ athletes: sim().athletes.map((a) => ({ ...a, status: 'near_limit' as const })) }),
  plan: OPT_PLAN,
  changes: [{ kind: 'insert_break', drill_id: 'b2', detail: 'Added a break' }],
  load_kept_pct: 80,
  feasible: true,
}

type Calls = { method: string; path: string; body: unknown }[]

function mockEngine(calls: Calls, opts: { down?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/engine/, '')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method: init?.method ?? 'GET', path, body })
    if (opts.down) throw new TypeError('fetch failed')
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'Content-Type': 'application/json' } })
    if (path === '/demo/inputs') return json(INPUTS)
    if (path === '/settings') return json({ owner: 'athletic trainer', settings: [] })
    if (path === '/sources') return json({})
    if (path === '/node/latest') return json({ reading: null, series: [], file: null, labels: ['no field recording yet'] })
    if (path.startsWith('/simulate')) return json(sim())
    if (path.startsWith('/optimize')) return json(OPT)
    if (path.startsWith('/live/replay')) return json(replay())
    return new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
  })
}

async function fresh() {
  vi.resetModules()
  const planStore = (await import('../planStore')).planStore
  const { engine, athleteOf } = await import('../engine')
  const { engineMeta } = await import('../engineMeta')
  return { planStore, engine, athleteOf, engineMeta }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const sims = (calls: Calls) => calls.filter((c) => c.path.startsWith('/simulate'))

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  }
}

describe('planStore + session against the engine', () => {
  let calls: Calls
  beforeEach(() => {
    calls = []
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('boot: shows the engine demo plan and its /simulate numbers; replays HR only on that plan', async () => {
    vi.stubGlobal('fetch', mockEngine(calls))
    const { planStore, engine, athleteOf } = await fresh()
    await planStore.boot()
    await flush()
    expect(calls.map((c) => c.path)).toEqual(expect.arrayContaining(['/demo/inputs', '/simulate?demo=1', '/live/replay?demo=1']))
    const s = engine.getSnapshot()
    expect(s.source).toBe('engine')
    expect(s.limitC).toBe(39.0)
    expect(s.weather?.fhsaa_zone).toBe(2)
    expect(athleteOf(s, 'a02').coreC).toBe(37.0)
    expect(athleteOf(s, 'a02').status).toBe('over_limit')
    expect(s.replay.label).toBe('replay · synthetic HR file (not a real athlete)')
    expect(planStore.get().offline).toBe(false)
  })

  it('offline: the same screens get "—" and the offline badge state, never stand-in numbers', async () => {
    vi.stubGlobal('fetch', mockEngine(calls, { down: true }))
    const { planStore, engine, athleteOf, engineMeta } = await fresh()
    await planStore.boot()
    const s = engine.getSnapshot()
    expect(engineMeta.get().link).toBe('offline')
    expect(planStore.get().offline).toBe(true)
    expect(planStore.get().sim).toBeNull()
    expect(s.source).toBe('offline')
    expect(s.plan?.drills.length).toBeGreaterThan(0) // plan structure from the fixture JSON
    const a = athleteOf(s, 'a01')
    expect([a.coreC, a.peakP95C, a.status, a.hr]).toEqual([null, null, null, null])
    expect(fmtCore(a.coreC, s.limitC)).toBe('—')
    expect(s.weather).toBeNull()
    expect(s.limitC).toBeNull()
  })

  it('a voice draft is simulated only after Confirm', async () => {
    vi.stubGlobal('fetch', mockEngine(calls))
    const { planStore } = await fresh()
    await planStore.boot()
    const before = sims(calls).length
    const draft: PlanDraft = {
      plan: { ...PLAN, id: 'plan-voice' },
      transcript: 'warmup, water, team period',
      assumptions: [],
      unclear: [],
      total_min: 10,
      needs_confirmation: true,
      labels: ['parsed by AI — coach must confirm'],
      model: 'test',
    }
    // The draft exists (the dock shows it) — nothing has run on it.
    expect(sims(calls).length).toBe(before)
    await planStore.confirm(draft)
    expect(sims(calls).length).toBe(before + 1)
    expect((sims(calls).at(-1)!.body as { plan: PracticePlan }).plan.id).toBe('plan-voice')
    expect(planStore.get().source).toBe('voice')
  })

  it('optimize starts from the coach\'s plan (max_load) and Undo survives a reload', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', mockEngine(calls))
    let { planStore } = await fresh()
    await planStore.boot()
    await planStore.optimize()
    const opt = calls.find((c) => c.path.startsWith('/optimize'))!
    expect(opt.path).toBe('/optimize?demo=1&preset=max_load')
    expect((opt.body as { plan: PracticePlan }).plan.drills).toHaveLength(PLAN.drills.length)
    expect(planStore.get().source).toBe('optimized')

    // reload
    ;({ planStore } = await fresh())
    await planStore.boot()
    expect(planStore.get().source).toBe('optimized')
    expect(planStore.get().plan.drills).toHaveLength(OPT_PLAN.drills.length)
    expect(planStore.get().previous?.plan.drills).toHaveLength(PLAN.drills.length)
    planStore.undo()
    await flush()
    expect(planStore.get().plan.drills).toHaveLength(PLAN.drills.length)
    expect(planStore.get().source).toBe('fixture')
  })
})
