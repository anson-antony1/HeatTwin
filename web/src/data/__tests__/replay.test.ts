import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveReplay, ReplayFrame, SimulationResult } from '../engineApi'
import { athleteAtMinute, basisLabel, firstFlagMinute, frameAt, hrAt, noHrLabel } from '../selectors'
import { replayLabel } from '../engine'

// Shaped like POST /live/replay (CONTRACTS v1.3 LiveReplay). Values are
// test-only numbers chosen to make index arithmetic visible.

const planForecast: SimulationResult = {
  plan_id: 'p',
  step_min: 1,
  times: ['t1', 't2', 't3', 't4', 't5'],
  weather: [],
  athletes: [
    { id: 'hr1', core_c_p50: [1, 2, 3, 4, 5], core_c_p95: [2, 3, 4, 5, 6], first_cross_min: null, peak_core_c_p95: 6, status: 'near_limit' },
    { id: 'nohr', core_c_p50: [7, 7, 7, 7, 7], core_c_p95: [8, 8, 8, 8, 8], first_cross_min: null, peak_core_c_p95: 8, status: 'below_limit' },
  ],
  limit_core_c: 10,
  fhsaa_violations: [],
  training_load_met_min: 0,
  labels: ['estimate — planning only'],
}

function frame(minute: number, base: number, gates: Partial<ReplayFrame['gates']> = {}): ReplayFrame {
  return {
    minute,
    athlete_id: 'hr1',
    hr_bpm: 100 + minute,
    calib: { met_scale: 1, met_scale_sd: 0 },
    gates: { crossing: false, persistent: false, coverage_ok: false, coverage_fraction: 0, n_updates: minute, flag: false, held_by: ['coverage_ok'], message: 'not enough data', ...gates },
    athlete: {
      core_c_p50: [base, base + 1, base + 2, base + 3, base + 4],
      core_c_p95: [base + 10, base + 11, base + 12, base + 13, base + 14],
      peak_core_c_p95: base + 14,
      status: 'over_limit',
      first_cross_min: 3,
    },
  }
}

const replay: LiveReplay = {
  source: { file: 'fixtures/hr_a07_synthetic.csv', synthetic: true, athletes: ['hr1'], n_readings: 4, first_ts: '', last_ts: '', aligned_to_plan_start: false },
  plan_forecast: planForecast,
  frames: [
    frame(1, 100),
    frame(2, 200, { coverage_ok: true, held_by: ['crossing'], message: 'no crossing in re-forecast' }),
    frame(3, 300, { coverage_ok: true, crossing: true, persistent: true, flag: true, held_by: [], message: 're-forecast shows crossing' }),
  ],
  hr_series: { hr1: [[0, 90], [1, 91], [2, 92], [3, 93]] },
  labels: ['replay', 'synthetic HR (not a real athlete)'],
}

describe('replay frame selection at minute m', () => {
  it('takes the latest frame with frame.minute <= m, none before the first', () => {
    expect(frameAt(replay, 'hr1', 0.5)).toBeNull()
    expect(frameAt(replay, 'hr1', 1)?.minute).toBe(1)
    expect(frameAt(replay, 'hr1', 2.9)?.minute).toBe(2)
    expect(frameAt(replay, 'hr1', 50)?.minute).toBe(3)
    expect(frameAt(replay, 'nohr', 50)).toBeNull()
    expect(frameAt(null, 'hr1', 2)).toBeNull()
  })

  it('reads HR from hr_series at m and stops when the file ends', () => {
    expect(hrAt(replay, 'hr1', 0)).toBe(90)
    expect(hrAt(replay, 'hr1', 2.5)).toBe(92)
    expect(hrAt(replay, 'hr1', 4)).toBe(93) // within one sample spacing of the last point
    expect(hrAt(replay, 'hr1', 4.01)).toBeNull() // recording over
    expect(hrAt(replay, 'nohr', 2)).toBeNull()
  })

  it('finds the first engine flag', () => {
    expect(firstFlagMinute(replay)).toBe(3)
    expect(firstFlagMinute(null)).toBeNull()
  })
})

describe('athlete at minute m with the replay', () => {
  it('before the first frame: plan forecast, with HR shown', () => {
    const a = athleteAtMinute({ id: 'hr1', minute: 0.5, totalMin: 5, plan: planForecast, replay })!
    expect(a.basis).toBe('plan_forecast')
    expect(a.coreC).toBe(1)
    expect(a.hr).toBe(90)
    expect(a.status).toBe('near_limit')
    expect(basisLabel(a)).toBe('plan forecast — waiting for the first HR calibration')
  })

  it('after a frame: that frame’s core_c_p50/p95 at m, its status, peak and gates', () => {
    const a = athleteAtMinute({ id: 'hr1', minute: 2.5, totalMin: 5, plan: planForecast, replay })!
    expect(a.basis).toBe('hr_replay')
    expect(a.coreC).toBe(201) // frame 2, minute 2 → index 1
    expect(a.p95C).toBe(211)
    expect(a.bandC).toBe(10)
    expect(a.peakP95C).toBe(214)
    expect(a.status).toBe('over_limit')
    expect(a.firstCrossMin).toBe(3)
    expect(a.calibrated).toBe(true)
    expect(a.flag).toBe(false)
    expect(basisLabel(a)).toBe('HR-calibrated estimate (replay)')
    // History is the estimate that was in force at each past minute.
    expect(a.history).toEqual([1, 100, 201])
  })

  it('"HR-calibrated" only once the engine gates report enough updates', () => {
    const a = athleteAtMinute({ id: 'hr1', minute: 1.2, totalMin: 5, plan: planForecast, replay })!
    expect(a.basis).toBe('hr_replay')
    expect(a.calibrated).toBe(false)
    expect(basisLabel(a)).toBe('HR replay · engine gates: not enough data')
  })

  it('alerts only on the engine flag, with its message', () => {
    const a = athleteAtMinute({ id: 'hr1', minute: 3, totalMin: 5, plan: planForecast, replay })!
    expect(a.flag).toBe(true)
    expect(a.gates?.message).toBe('re-forecast shows crossing')
  })

  it('athletes without HR read the plan forecast only', () => {
    const a = athleteAtMinute({ id: 'nohr', minute: 3, totalMin: 5, plan: planForecast, replay })!
    expect(a.basis).toBe('plan_forecast')
    expect(a.hr).toBeNull()
    expect(a.coreC).toBe(7)
    expect(noHrLabel(a)).toBe('plan forecast only — no HR')
  })

  it('says the HR replay ended instead of freezing the last bpm', () => {
    const a = athleteAtMinute({ id: 'hr1', minute: 4.5, totalMin: 5, plan: planForecast, replay })!
    expect(a.hr).toBeNull()
    expect(noHrLabel(a)).toBe('HR replay ended · HR-calibrated estimate (replay)')
  })
})

describe('replay provenance label', () => {
  it('names the synthetic file’s athletes and says it is not a real athlete', () => {
    expect(replayLabel({ status: 'ready', synthetic: true, file: 'fixtures/hr_a07_synthetic.csv', athletes: ['a07'], error: null })).toBe(
      'replay of a synthetic HR file (a07) — not a real athlete',
    )
    expect(replayLabel({ status: 'loading', synthetic: false, file: null, athletes: [], error: null })).toBeNull()
  })
})

describe('session plays back POST /live/replay', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests the replay for the plan and switches HR athletes to the frames', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`)
      return new Response(JSON.stringify(replay), { status: 200 })
    })
    vi.resetModules()
    const { engine } = await import('../engine')
    const plan = { id: 'p', site: { name: 's', lat: 0, lon: 0, surface: 'grass' as const }, start: '2026-10-04T15:30:00-04:00', drills: [
      { id: 'd1', name: 'x', duration_min: 5, intensity: 'hard' as const, gear: 'helmet' as const, shade: false, is_break: false, priority: 1 as const, movable: true },
    ] }
    engine.setPlan(plan, planForecast)
    await vi.waitFor(() => expect(engine.getSnapshot().replay.status).toBe('ready'))
    expect(calls).toEqual(['POST /engine/live/replay?demo=1'])
    engine.seek(3)
    const s = engine.getSnapshot()
    expect(s.athletes.hr1.flag).toBe(true)
    expect(s.athletes.nohr.basis).toBe('plan_forecast')
    expect(s.firstFlagMinute).toBe(3)
    expect(s.labels).toContain('synthetic HR (not a real athlete)')
  })
})
