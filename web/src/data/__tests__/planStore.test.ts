import { afterEach, describe, expect, it, vi } from 'vitest'
import planFile from '../../../../fixtures/plan.json'
import rosterFile from '../../../../fixtures/roster.json'
import { basisLabel } from '../selectors'
import { OFFLINE_LABEL, offlineAthleteAt, offlineSimulate } from '../../offline/standIn'
import type { PracticePlan } from '../llmPlan'
import type { RosterAthlete } from '../engineApi'

// planStore.boot(): the app's first paint reads engine numbers — GET
// /demo/inputs then POST /simulate?demo=1 for that plan — and falls back to the
// badged stand-in only when the engine can't be reached.

const plan = planFile.plan as unknown as PracticePlan
const roster = rosterFile.roster as RosterAthlete[]

function engineSim(planId: string) {
  return {
    plan_id: planId,
    step_min: 1,
    times: ['t'],
    weather: [],
    athletes: roster.map((a) => ({ id: a.id, name: a.name, core_c_p50: [1], core_c_p95: [2], first_cross_min: null, peak_core_c_p95: 2, status: 'below_limit' })),
    limit_core_c: 3,
    fhsaa_violations: [],
    training_load_met_min: 0,
    labels: ['estimate — planning only'],
  }
}

async function freshStores() {
  vi.resetModules()
  const { planStore } = await import('../planStore')
  const { engineMeta } = await import('../engineMeta')
  const { engine } = await import('../engine')
  return { planStore, engineMeta, engine }
}

afterEach(() => vi.unstubAllGlobals())

describe('planStore.boot', () => {
  it('shows the engine demo plan and its /simulate result before any coach confirm', async () => {
    const enginePlan = { ...plan, id: 'plan-from-engine' }
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url.includes('/demo/inputs')
        ? { plan: enginePlan, roster, weather: [], labels: ['synthetic plan (fixture)'], synthetic: { plan: true, roster: true, weather: false } }
        : url.includes('/simulate')
          ? engineSim(JSON.parse(String(init?.body)).plan.id)
          : url.includes('/settings')
            ? { owner: 'athletic trainer', settings: [] }
            : url.includes('/node/latest')
              ? { reading: null, series: [], file: null, labels: ['no field recording yet'] }
              : {}
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const { planStore, engineMeta, engine } = await freshStores()
    await planStore.boot()
    const s = planStore.get()
    expect(s.plan.id).toBe('plan-from-engine')
    expect(s.sim?.plan_id).toBe('plan-from-engine')
    expect(s.offline).toBeNull()
    expect(s.phase).toBe('ready')
    expect(engineMeta.get().link).toBe('online')
    expect(calls).toContain('POST /engine/simulate?demo=1')
    // The session reads the engine result, not a browser model.
    const live = engine.getSnapshot()
    expect(live.source).toBe('engine')
    expect(Object.keys(live.athletes)).toHaveLength(roster.length)
    expect(live.limitC).toBe(3)
  })

  it('falls back to the stand-in, badged OFFLINE FALLBACK, only when the engine is unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    const { planStore, engineMeta, engine } = await freshStores()
    await planStore.boot()
    const s = planStore.get()
    expect(s.sim).toBeNull()
    expect(s.offline?.labels[0]).toBe(OFFLINE_LABEL)
    expect(engineMeta.get().link).toBe('offline')
    const live = engine.getSnapshot()
    expect(live.source).toBe('offline')
    const one = Object.values(live.athletes)[0]
    expect(one.basis).toBe('offline')
    expect(basisLabel(one)).toBe(OFFLINE_LABEL)
  })

  it('does not go offline when the engine answers with an error (it shows the error instead)', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/simulate')
        ? new Response(JSON.stringify({ detail: 'roster is empty' }), { status: 422 })
        : new Response(JSON.stringify({ plan, roster, weather: [], labels: [], synthetic: { plan: true, roster: true, weather: false } }), { status: 200 }),
    )
    const { planStore } = await freshStores()
    await planStore.boot()
    const s = planStore.get()
    expect(s.phase).toBe('error')
    expect(s.error).toBe('roster is empty')
    expect(s.offline).toBeNull()
  })
})

describe('the HR replay follows the plan it was recorded on (S1)', () => {
  it('replays on the demo plan, not on the optimized plan, and again after Undo', async () => {
    const replayBody = {
      source: { file: 'fixtures/hr_a07_synthetic.csv', synthetic: true, athletes: ['a07'], n_readings: 1, first_ts: '', last_ts: '', aligned_to_plan_start: false },
      plan_forecast: engineSim(plan.id),
      frames: [],
      hr_series: { a07: [[0, 100]] },
      labels: ['replay', 'synthetic HR (not a real athlete)'],
    }
    // Same id, different drills — what /optimize returns for the demo plan.
    const optimizedPlan = { ...plan, drills: [...plan.drills].reverse() }
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      const body = url.includes('/demo/inputs')
        ? { plan, roster, weather: [], labels: [], synthetic: { plan: true, roster: true, weather: false } }
        : url.includes('/simulate')
          ? engineSim(plan.id)
          : url.includes('/optimize')
            ? { original: engineSim(plan.id), optimized: engineSim(plan.id), plan: optimizedPlan, changes: [], load_kept_pct: 90, feasible: true }
            : url.includes('/live/replay')
              ? replayBody
              : url.includes('/settings')
                ? { owner: 'athletic trainer', settings: [] }
                : {}
      return new Response(JSON.stringify(body), { status: 200 })
    })
    const { planStore, engine } = await freshStores()
    const replays = () => calls.filter((c) => c.includes('/live/replay')).length

    await planStore.boot()
    await vi.waitFor(() => expect(engine.getSnapshot().replay.status).toBe('ready'))
    expect(replays()).toBe(1)

    await planStore.optimize()
    expect(planStore.get().source).toBe('optimized')
    expect(engine.getSnapshot().replay.status).toBe('other_plan')
    expect(engine.getSnapshot().athletes.a07.basis).toBe('plan_forecast')
    expect(replays()).toBe(1)

    planStore.undo()
    await vi.waitFor(() => expect(engine.getSnapshot().replay.status).toBe('ready'))
    expect(replays()).toBe(2)
    expect(calls.filter((c) => c.includes('/live/replay')).every((c) => c === 'POST /engine/live/replay?demo=1')).toBe(true)
  })
})

describe('offline stand-in', () => {
  it('labels every result and athlete OFFLINE FALLBACK and generates no heart rate', () => {
    const off = offlineSimulate(plan, roster)
    expect(off.labels).toContain(OFFLINE_LABEL)
    expect(off.athletes).toHaveLength(roster.length)
    const a = offlineAthleteAt(off, roster[0].id, 30)!
    expect(a.basis).toBe('offline')
    expect(a.hr).toBeNull()
    expect(a.flag).toBe(false)
  })
})
