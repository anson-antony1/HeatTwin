import { describe, expect, it } from 'vitest'
import { rosterView } from '../roster'
import { athleteFromLive } from '../selectors'
import type { LiveSuggestion, RosterAthlete } from '../engineApi'
import { liveState } from './helpers'

const LIVE1 = { id: 'live1', name: 'Demo athlete (live)', position: 'ATH', height_m: 1.78, mass_kg: 75, age_yr: 17, sex: 'male', acclimatization_day: 8 } as unknown as RosterAthlete

describe('live demo (v1.7)', () => {
  it('adds the live-only athlete to the roster once, after the engine roster', () => {
    const inputs = { roster: [{ ...LIVE1, id: 'a01', name: 'Marcus (fictional)' }], synthetic: { roster: true } } as never
    const v = rosterView({ inputs }, [LIVE1])
    expect(v.athletes.map((a) => a.id)).toEqual(['a01', 'live1'])
    expect(v.name('live1')).toBe('Demo athlete (live)')
    expect(rosterView({ inputs }, [LIVE1, LIVE1]).athletes).toHaveLength(2)
    expect(rosterView({ inputs }).athletes).toHaveLength(1)
  })

  it("carries the engine's suggestion only while that strap is received", () => {
    const sug: LiveSuggestion = {
      athlete_id: 'a02', changes: [{ kind: 'rotate_out', drill_id: 'd4', detail: "rotate out of 'Team period'" }],
      text: 'Suggested …', outcome: 'HR-calibrated re-forecast peak 39.42 → 38.79 °C (p95), under the planning line. Estimate — planning only.',
      before: { peak_core_c_p95: 39.42, first_cross_min: 44 }, after: { peak_core_c_p95: 38.79, first_cross_min: null, under_line: true },
      at_minute: 3, labels: [],
    }
    const s = liveState()
    const entry = { ...s.athletes.a02, suggestion: sug }
    const row = athleteFromLive({ id: 'a02', minute: 3, totalMin: 9, reforecast: s.reforecast!, entry })
    expect(row?.suggestion?.outcome).toContain('38.79')
    const gone = athleteFromLive({ id: 'a02', minute: 3, totalMin: 9, reforecast: s.reforecast!, entry: { ...entry, receiving: false } })
    expect(gone?.suggestion ?? null).toBeNull()
  })
})
