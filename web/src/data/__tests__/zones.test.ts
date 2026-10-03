import { describe, expect, it } from 'vitest'
import type { FhsaaZoneRule, WeatherHour } from '../engineApi'
import { weatherHourAt, zoneRule, zoneRuleText } from '../selectors'

// The zone for a practice minute is the engine's WeatherHour.fhsaa_zone for the
// hour containing that minute — no web cut-offs, no interpolation.

function hour(time: string, wbgt_f: number, fhsaa_zone: WeatherHour['fhsaa_zone']): WeatherHour {
  return { time, air_temp_c: 0, rh_pct: 0, wind_m_s: 0, cloud_cover_pct: 0, wbgt_f, fhsaa_zone, source: 'fixture' }
}

const weather = [
  hour('2026-10-04T15:00:00-04:00', 86, 2),
  hour('2026-10-04T16:00:00-04:00', 83, 2),
  hour('2026-10-04T17:00:00-04:00', 82, 1),
]
const start = '2026-10-04T15:30:00-04:00'

describe('weatherHourAt', () => {
  it('uses the hour that contains the minute', () => {
    expect(weatherHourAt(weather, start, 0)?.time).toBe('2026-10-04T15:00:00-04:00')
    expect(weatherHourAt(weather, start, 29.9)?.time).toBe('2026-10-04T15:00:00-04:00')
    expect(weatherHourAt(weather, start, 30)?.time).toBe('2026-10-04T16:00:00-04:00')
    expect(weatherHourAt(weather, start, 90)?.fhsaa_zone).toBe(1)
  })

  it('does not invent a zone outside the hours the engine sent', () => {
    expect(weatherHourAt(weather, start, 150)).toBeNull()
    expect(weatherHourAt(weather, '2026-10-04T14:00:00-04:00', 0)).toBeNull()
  })

  it('handles offsets (the same instant in UTC)', () => {
    expect(weatherHourAt(weather, '2026-10-04T19:30:00Z', 0)?.time).toBe('2026-10-04T15:00:00-04:00')
  })

  it('never interpolates WBGT between hours', () => {
    expect(weatherHourAt(weather, start, 29)?.wbgt_f).toBe(86)
  })
})

describe('zone rules from /sources', () => {
  const rules: FhsaaZoneRule[] = [
    { zone: 1, wbgt_f_max: 82, activity: 'normal', breaks_per_hour: 0, break_min: 0, max_duration_min: null, gear: 'any' },
    { zone: 3, wbgt_f_max: 90, activity: 'max 2 h', breaks_per_hour: 4, break_min: 4, max_duration_min: 120, gear: 'football: helmet, shoulder pads, shorts only' },
  ]

  it('looks the rule up by the engine zone number', () => {
    expect(zoneRule(rules, 3)?.activity).toBe('max 2 h')
    expect(zoneRule(rules, 2)).toBeNull()
    expect(zoneRule(undefined, 3)).toBeNull()
    expect(zoneRule(rules, null)).toBeNull()
  })

  it('writes rule text only from the cited table fields', () => {
    expect(zoneRuleText(rules[0])).toBe('normal')
    expect(zoneRuleText(rules[1])).toBe('max 2 h · 4 breaks of 4 min per hour · max 120 min · football: helmet, shoulder pads, shorts only')
  })
})
