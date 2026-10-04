import { describe, expect, it } from 'vitest'
import {
  athleteAtMinute,
  athleteFromLive,
  drillAtMinute,
  fieldSourceLabel,
  firstCrossing,
  frameAt,
  hottestPeakP95,
  hrAt,
  indexAtMinute,
  modelLabel,
  nextBreakIn,
  offlineAthlete,
  overCount,
  peakZone,
  seriesByMinute,
  statusTone,
  weatherHourAt,
  zoneRule,
  zoneRuleText,
  zoneShortText,
} from '../selectors'
import type { FhsaaZoneRule } from '../engineApi'
import { liveApplies, liveLabel } from '../liveStore'
import { liveState, PLAN, replay, sim, WEATHER } from './helpers'

describe('engine series → practice minutes', () => {
  it('reads the latest output at or before the minute (no interpolation)', () => {
    expect(indexAtMinute(1, 10, 0)).toBe(0)
    expect(indexAtMinute(1, 10, 3.7)).toBe(2)
    expect(indexAtMinute(1, 10, 99)).toBe(9)
    expect(seriesByMinute([1, 2, 3], 1, 3)).toEqual([1, 1, 2, 3])
  })
})

describe('engine result → view values', () => {
  it('maps one athlete at a minute: estimate, band, peak, status, first crossing', () => {
    const s = sim()
    const a = athleteAtMinute({ id: 'a02', minute: 4, totalMin: 10, plan: s, replay: null })!
    expect(a.coreC).toBe(37.6) // p50 at the end of minute 4
    expect(a.bandC).toBeCloseTo(38.1 - 37.6, 10)
    expect(a.peakP95C).toBe(39.9) // engine peak_core_c_p95
    expect(a.peakMin).toBe(10)
    expect(a.status).toBe('over_limit')
    expect(a.firstCrossMin).toBe(7)
    expect(a.hr).toBeNull()
    expect(a.basis).toBe('plan_forecast')
    expect(a.history).toEqual([37.0, 37.0, 37.2, 37.4, 37.6])
    expect(statusTone(a.status)).toBe('watch')        // forecast over the line, not flagged → voice-plan's Watch
    expect(statusTone(a.status, true)).toBe('watch')  // the engine's early warning is an amber heads-up
    expect(statusTone(a.status, true, true)).toBe('alert') // red only when the estimate itself passes the line
  })

  it('summaries are engine fields: over-the-line count, hottest p95', () => {
    expect(overCount(sim())).toBe(1)
    expect(hottestPeakP95(sim())).toBe(39.9)
    expect(overCount(null)).toBeNull()
  })

  it("status tones: alert = estimate over the line, watch = engine heads-up or forecast near/over, steady = below", () => {
    expect(statusTone('below_limit')).toBe('steady')
    expect(statusTone('near_limit')).toBe('watch')
    expect(statusTone('over_limit')).toBe('watch')
    expect(statusTone('below_limit', true)).toBe('watch')
    expect(statusTone('over_limit', true)).toBe('watch')
    expect(statusTone('over_limit', true, true)).toBe('alert')
    expect(statusTone(null)).toBe('none')
  })

  it('heads-up text, red alert and skip-to-heat come from engine estimates', async () => {
    const { estimateOverLine, headsUp, minutesOverLine, firstEstimateCrossing } = await import('../selectors')
    expect(estimateOverLine({ coreC: 38.99 }, 39)).toBe(false)
    expect(estimateOverLine({ coreC: 39.0 }, 39)).toBe(true)
    expect(headsUp({ flag: true, firstCrossMin: 44, coreC: 37.1 }, 39)).toBe('Re-forecast crosses the planning line at 44′')
    expect(headsUp({ flag: true, firstCrossMin: 44, coreC: 39.2 }, 39)).toBeNull()   // over the line → red alert instead
    expect(headsUp({ flag: false, firstCrossMin: 44, coreC: 37.1 }, 39)).toBeNull()
    expect(minutesOverLine([38.5, 39.1, 38.9, 39.0, 39.2], 39)).toBe(2)
    expect(firstEstimateCrossing({ a: { forecast: [37, 38, 39.1] }, b: { forecast: [37, 39.0, 40] } }, 39)).toBe(1)
    expect(firstEstimateCrossing({ a: { forecast: [37, 38] } }, 39)).toBeNull()
  })

  it('offline rows carry no numbers', () => {
    const o = offlineAthlete('a01')
    expect([o.coreC, o.peakP95C, o.status, o.hr]).toEqual([null, null, null, null])
    expect(o.basis).toBe('offline')
    expect(modelLabel(o)).toMatch(/offline fallback/)
  })
})

describe('HR replay frame at minute m', () => {
  it('uses the latest calibration frame at or before m, with its gates', () => {
    const r = replay()
    expect(frameAt(r, 'a01', 1)).toBeNull()
    expect(frameAt(r, 'a01', 4.9)!.minute).toBe(2)
    expect(frameAt(r, 'a01', 7)!.minute).toBe(5)
    const before = athleteAtMinute({ id: 'a01', minute: 1, totalMin: 10, plan: r.plan_forecast, replay: r })!
    expect(before.basis).toBe('plan_forecast')
    expect(before.hasHr).toBe(true)
    const at = athleteAtMinute({ id: 'a01', minute: 6, totalMin: 10, plan: r.plan_forecast, replay: r })!
    expect(at.basis).toBe('hr_replay')
    expect(at.coreC).toBe(38.0)
    expect(at.flag).toBe(true)
    expect(at.calibrated).toBe(true)
    expect(at.status).toBe('over_limit')
    expect(at.hr).toBe(160)
    // history: plan forecast before the first frame, then the frame in force at each minute
    expect(at.history.slice(0, 2)).toEqual([37.0, 37.0])
    expect(at.history[3]).toBe(37.5)
    expect(at.history[6]).toBe(38.0)
  })

  it('HR stops once the recording has ended', () => {
    const r = replay()
    expect(hrAt(r, 'a01', 2.5)).toBe(130)
    expect(hrAt(r, 'a01', 7)).toBeNull()
    expect(hrAt(r, 'a02', 2)).toBeNull()
  })

  it('"Skip to heat" is the engine\'s earliest crossing', () => {
    const s = sim()
    const rows = Object.fromEntries(s.athletes.map((a) => [a.id, athleteAtMinute({ id: a.id, minute: 0, totalMin: 10, plan: s, replay: null })!]))
    expect(firstCrossing(rows)).toBe(7)
  })
})

describe('live state mapping (GET /live/state)', () => {
  it('a received strap shows its HR and the engine re-forecast; others the session reforecast', () => {
    const s = liveState()
    const mapped = athleteFromLive({ id: 'a02', minute: 4, totalMin: 10, reforecast: s.reforecast!, entry: s.athletes.a02 })!
    expect(mapped.hr).toBe(171)
    expect(mapped.basis).toBe('live')
    expect(mapped.coreC).toBe(38.2)
    expect(mapped.peakP95C).toBe(39.4)
    expect(mapped.flag).toBe(true)
    expect(mapped.liveSource).toBe('live · Amazfit Helio Strap')
    expect(modelLabel(mapped)).toBe('live · Amazfit Helio Strap · calibrated from HR')

    const other = athleteFromLive({ id: 'a01', minute: 4, totalMin: 10, reforecast: s.reforecast!, entry: undefined })!
    expect(other.hr).toBeNull()
    expect(other.basis).toBe('plan_forecast')
    expect(other.coreC).toBe(37.3)
    expect(other.flag).toBe(false)
  })

  it('a stale strap is not shown as live', () => {
    const s = liveState()
    const stale = { ...s.athletes.a02, receiving: false }
    const a = athleteFromLive({ id: 'a02', minute: 4, totalMin: 10, reforecast: s.reforecast!, entry: stale })!
    expect(a.hr).toBeNull()
    expect(a.basis).toBe('plan_forecast')
  })

  it('applies only to a received session on the plan on screen; labels come from the engine', () => {
    expect(liveApplies(liveState(), PLAN)).toBe('on')
    expect(liveApplies(liveState({ receiving: false }), PLAN)).toBe('off')
    expect(liveApplies(liveState({ active: false }), PLAN)).toBe('off')
    expect(liveApplies(liveState({ plan_id: 'other' }), PLAN)).toBe('other_plan')
    // same id, different length (an optimized plan keeps the id)
    expect(liveApplies(liveState(), { ...PLAN, drills: PLAN.drills.slice(0, 2) })).toBe('other_plan')
    expect(liveApplies(null, PLAN)).toBe('off')
    expect(liveLabel(liveState())).toBe('live · Amazfit Helio Strap')
  })

  it('appends the live-demo mapping to the strap label, never in place of it', () => {
    const labels = ['live demo · conditioning', 'live · Amazfit Helio Strap', 'synthetic roster']
    expect(liveLabel(liveState({ labels }))).toBe('live · Amazfit Helio Strap · live demo · conditioning')
    const replayed = ['live demo · conditioning', 'replay (hr_bridge) · Amazfit Helio Strap']
    expect(liveLabel(liveState({ labels: replayed }))).toBe('replay (hr_bridge) · Amazfit Helio Strap · live demo · conditioning')
    expect(liveLabel(liveState({ labels: ['live demo · conditioning', 'live session — no HR yet'] }))).toBeNull()
  })
})

describe('field card source chip', () => {
  it('says when a live session runs on the time-shifted forecast snapshot', () => {
    expect(fieldSourceLabel({ source: 'fixture', time_shifted_min: -195 })).toBe('Forecast snapshot (time-shifted)')
    expect(fieldSourceLabel({ source: 'fixture' })).toBe('NWS fixture')
    expect(fieldSourceLabel({ source: 'nws_forecast' })).toBe('NWS forecast')
    expect(fieldSourceLabel(null)).toBe('—')
  })
})

describe('zones come from the engine', () => {
  const RULES: FhsaaZoneRule[] = [
    { zone: 1, wbgt_f_max: 82, activity: 'normal', breaks_per_hour: 0, break_min: 0, max_duration_min: null, gear: 'any' },
    { zone: 2, wbgt_f_max: 87, activity: 'unrestricted', breaks_per_hour: 3, break_min: 4, max_duration_min: null, gear: 'any' },
    { zone: 5, wbgt_f_max: 999, activity: 'no outdoor activity', breaks_per_hour: null, break_min: null, max_duration_min: 0, gear: 'n/a' },
  ]

  it('the hour containing the minute carries the engine zone (no interpolation)', () => {
    expect(weatherHourAt(WEATHER, PLAN.start, 0)!.fhsaa_zone).toBe(2)
    expect(weatherHourAt(WEATHER, PLAN.start, 31)!.wbgt_f).toBe(83)
    expect(weatherHourAt(WEATHER, PLAN.start, 200)).toBeNull()
    expect(weatherHourAt(WEATHER, PLAN.start, 200, true)!.wbgt_f).toBe(83) // the engine's nearest hour
    expect(peakZone(WEATHER, PLAN.start, 10)).toBe(2)
  })

  it('rule text comes from /sources', () => {
    expect(zoneRuleText(zoneRule(RULES, 2)!)).toBe('3 breaks of 4 min per hour')
    expect(zoneShortText(zoneRule(RULES, 2)!)).toBe('3 breaks/h')
    expect(zoneShortText(zoneRule(RULES, 5)!)).toBe('no outdoor activity')
    expect(zoneRule(RULES, 3)).toBeNull()
  })
})

describe('plan structure', () => {
  it('drill and next break at a minute', () => {
    expect(drillAtMinute(PLAN.drills, 5)!.drill.id).toBe('b1')
    expect(nextBreakIn(PLAN.drills, 1)).toBe(3)
    expect(nextBreakIn(PLAN.drills, 5)).toBe(0)
    expect(nextBreakIn(PLAN.drills, 7)).toBeNull()
  })
})

describe('body surface area from the engine coefficients', () => {
  it('uses constants.body_surface_area from /sources (DuBois), null without sources', async () => {
    const { bodySurfaceAreaM2 } = await import('../selectors')
    const src = { body_surface_area: { coeff: 0.202, mass_exp: 0.425, height_exp: 0.725 } }
    expect(bodySurfaceAreaM2({ mass_kg: 125, height_m: 1.88 }, src)).toBeCloseTo(0.202 * 125 ** 0.425 * 1.88 ** 0.725, 10)
    expect(bodySurfaceAreaM2({ mass_kg: 125, height_m: 1.88 }, null)).toBeNull()
  })
})
