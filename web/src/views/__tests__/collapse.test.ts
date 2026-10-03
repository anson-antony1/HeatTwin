import { describe, expect, it } from 'vitest'
import { fetchNodeLatest, fetchSources, parseNodeLatest, type NodeLatest } from '../../data/sourcesApi'
import {
  CHECKLIST_IDS,
  checklistItems,
  countChecked,
  initialChecked,
  loadChecked,
  saveChecked,
} from '../collapse/checklist'
import {
  NO_TARGETS,
  buildSteps,
  extractCwiTargets,
  fmtCF,
  nataGoalText,
  nataWindowLabel,
  noRectalNote,
} from '../collapse/targets'
import { formatAge, tubDisplay, tubHandoffLine, tubVerdict } from '../collapse/tub'

// Shape of GET /sources for the blocks these screens read (values as in engine/constants.yaml).
const SOURCES = {
  ksi_cwi: {
    status: 'VERIFIED',
    source: 'Korey Stringer Institute, Cold Water Immersion Guide',
    water_temp_c_max: 15,
    no_rectal_thermometer_cool_min: [10, 15],
    remove_at_rectal_c: 39.0,
    tub_within_min_of_field: [5, 10],
  },
  nata_ehs: {
    status: 'VERIFIED',
    source: 'NATA Exertional Heat Illnesses position statement',
    goal_below_f_within_30min: 102.5,
  },
}
const T = extractCwiTargets(SOURCES)

const reading = (extra: Record<string, unknown>) =>
  ({ reading: { ts: '2026-10-03T15:02:00-04:00', ...extra }, labels: ['field node recording'] }) as unknown as NodeLatest

describe('tub temperature display', () => {
  it('says "no probe connected" when there is no node data at all', () => {
    expect(tubDisplay(null)).toEqual({ kind: 'none', full: 'Tub water temperature: no probe connected' })
    expect(tubDisplay(undefined).kind).toBe('none')
  })

  it('says "no probe connected" when reading is null', () => {
    const d = tubDisplay({ reading: null, labels: ['no field recording yet'] })
    expect(d.kind).toBe('none')
    expect(d.kind === 'none' && d.full).toBe('Tub water temperature: no probe connected')
  })

  it('says "no probe connected" when the reading has no numeric tub_temp_c', () => {
    expect(tubDisplay(reading({ globe_c: 41.3 })).kind).toBe('none')
    expect(tubDisplay(reading({ tub_temp_c: null })).kind).toBe('none')
    expect(tubDisplay(reading({ tub_temp_c: Number.NaN })).kind).toBe('none')
    expect(tubDisplay(reading({ tub_temp_c: '9.8' })).kind).toBe('none')
  })

  it('shows a real tub_temp_c in °F and °C with the node labels', () => {
    const d = tubDisplay(reading({ tub_temp_c: 9.8 }))
    expect(d.kind).toBe('reading')
    if (d.kind !== 'reading') return
    expect(d.cText).toBe('9.8 °C')
    expect(d.fText).toBe('49.6 °F')
    expect(d.labels).toEqual(['field node recording'])
    expect(tubHandoffLine(d)).toMatch(/^Tub water temperature: 49\.6 °F \/ 9\.8 °C \(field-node probe/)
  })

  it('the EMS hand-off line never carries a number without a probe', () => {
    expect(tubHandoffLine(tubDisplay(null))).toBe('Tub water temperature: no probe connected')
  })

  it('gives a verdict only for a real reading and a sourced KSI limit', () => {
    expect(tubVerdict(tubDisplay(null), T)).toBeNull()
    expect(tubVerdict(tubDisplay(reading({ tub_temp_c: 9.8 })), NO_TARGETS)).toBeNull()
    expect(tubVerdict(tubDisplay(reading({ tub_temp_c: 9.8 })), T)).toEqual({
      under: true,
      text: 'Under the KSI water limit of 15 °C (59 °F)',
    })
    expect(tubVerdict(tubDisplay(reading({ tub_temp_c: 18 })), T)?.under).toBe(false)
  })

  it('reports the age of a reading without inventing a threshold', () => {
    const t0 = Date.parse('2026-10-03T15:02:00-04:00')
    expect(formatAge('2026-10-03T15:02:00-04:00', t0 + 20_000)).toBe('just now')
    expect(formatAge('2026-10-03T15:02:00-04:00', t0 + 4 * 60_000)).toBe('4 min ago')
    expect(formatAge('2026-10-03T15:02:00-04:00', t0 + 3 * 3600_000)).toBe('3 h ago')
    expect(formatAge('not a time', t0)).toBeNull()
  })
})

describe('sourced numbers', () => {
  it('reads the numbers out of /sources', () => {
    expect(T.tubWaterMaxC).toBe(15)
    expect(T.noRectalCoolMin).toEqual([10, 15])
    expect(T.tubWithinMin).toEqual([5, 10])
    expect(T.removeAtRectalC).toBe(39)
    expect(T.nataGoalF).toBe(102.5)
    expect(T.nataGoalWindowMin).toBe(30)
    expect(fmtCF(15)).toBe('15 °C (59 °F)')
  })

  it('formats the NATA goal and the KSI note from /sources, with the citations', () => {
    expect(nataGoalText(T)).toBe(
      'NATA goal: rectal temperature below 102.5 °F within 30 min — only a rectal thermometer can confirm',
    )
    expect(noRectalNote(T)).toBe('KSI: 10–15 min without a rectal reading')
    expect(nataWindowLabel(T)).toBe('NATA goal window: 30 min')
  })

  it('falls back to text with no numbers when /sources is missing or unusable', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}, { ksi_cwi: null }, { ksi_cwi: { status: 'TODO', water_temp_c_max: 15 } }]) {
      expect(extractCwiTargets(bad)).toEqual(NO_TARGETS)
    }
    expect(nataGoalText(NO_TARGETS)).not.toMatch(/\d/)
    expect(nataGoalText(NO_TARGETS)).toMatch(/NATA/)
    expect(nataGoalText(NO_TARGETS)).toMatch(/only a rectal thermometer can confirm/)
    expect(noRectalNote(NO_TARGETS)).not.toMatch(/\d/)
    expect(noRectalNote(NO_TARGETS)).toMatch(/^KSI/)
    expect(nataWindowLabel(NO_TARGETS)).toBe('')
  })

  it('rejects malformed values inside an otherwise good block', () => {
    const t = extractCwiTargets({
      ksi_cwi: { status: 'VERIFIED', water_temp_c_max: '15', no_rectal_thermometer_cool_min: [15, 10], tub_within_min_of_field: [5] },
      nata_ehs: { status: 'VERIFIED', goal_below_f_within_30min: null },
    })
    expect(t.tubWaterMaxC).toBeNull()
    expect(t.noRectalCoolMin).toBeNull()
    expect(t.tubWithinMin).toBeNull()
    expect(t.nataGoalF).toBeNull()
    expect(t.nataGoalWindowMin).toBeNull()
  })
})

describe('protocol steps', () => {
  const text = (s: { detail: string; say: string; title: string }) => `${s.title} ${s.detail} ${s.say}`

  it('carry numbers only from /sources and attribute each step', () => {
    const steps = buildSteps(T)
    expect(steps.map((s) => s.id)).toEqual(['call', 'tub', 'stir', 'cool', 'handoff'])
    for (const s of steps) expect(s.source).toMatch(/^KSI Cold Water Immersion Guide/)
    const cool = steps.find((s) => s.id === 'cool')!
    expect(cool.detail).toContain('39 °C (102 °F)')
    expect(cool.detail).toContain('10–15 minutes')
    expect(steps.find((s) => s.id === 'stir')!.detail).toContain('under 15 °C (59 °F)')
  })

  it('show no numbers in detail or speech when /sources is missing', () => {
    for (const s of buildSteps(NO_TARGETS)) {
      expect(s.detail).not.toMatch(/\d/)
      expect(s.say).not.toMatch(/\d/)
    }
  })

  it('state observable facts, never a diagnosis, reassurance or a stop instruction', () => {
    for (const s of [...buildSteps(T), ...buildSteps(NO_TARGETS)]) {
      const t = text(s)
      expect(t).not.toMatch(/heat\s*stroke/i)
      expect(t).not.toMatch(/\b(safe|fine|ok|okay|cleared)\b/i)
      expect(t).not.toMatch(/(stop|end|halt)\s+(the\s+)?cooling/i)
      expect(t).not.toMatch(/do not stop/i)
    }
    expect(buildSteps(T)[0].detail).toContain('Athlete collapsed during practice in the heat')
  })
})

describe('Response checklist', () => {
  it('starts with every item unchecked', () => {
    const c = initialChecked()
    expect(Object.keys(c).sort()).toEqual([...CHECKLIST_IDS].sort())
    expect(Object.values(c).every((v) => v === false)).toBe(true)
    expect(countChecked(c)).toBe(0)
  })

  it('has the five items, with no invented readings or times', () => {
    for (const targets of [T, NO_TARGETS]) {
      const items = checklistItems(targets)
      expect(items.map((i) => i.id)).toEqual([...CHECKLIST_IDS])
      const all = items.map((i) => `${i.label} ${i.detail}`).join(' ')
      expect(all).not.toMatch(/Probe reads|Gate 3|Checked \d|\d:\d\d\s?[AP]M|within 1 minute/i)
    }
    expect(checklistItems(T)[0].detail).toBe('KSI: tub within 5–10 min of each field')
    expect(checklistItems(NO_TARGETS)[0].detail).not.toMatch(/\d/)
  })

  it('does not restore ticks from another day, bad JSON, or missing storage', () => {
    const store = (v: string | null) => ({ getItem: () => v })
    const today = '2026-10-03'
    const ticked = { date: today, checked: { tub: true, thermometer: false, path: true, phone: 'yes', rectal: false } }
    expect(loadChecked(null, today)).toEqual(initialChecked())
    expect(loadChecked(store(null), today)).toEqual(initialChecked())
    expect(loadChecked(store('{not json'), today)).toEqual(initialChecked())
    expect(loadChecked(store(JSON.stringify({ ...ticked, date: '2026-10-02' })), today)).toEqual(initialChecked())
    expect(loadChecked(store(JSON.stringify(ticked)), today)).toEqual({
      tub: true,
      thermometer: false,
      path: true,
      phone: false, // only a literal `true` counts
      rectal: false,
    })
    expect(
      loadChecked(
        {
          getItem: () => {
            throw new Error('blocked')
          },
        },
        today,
      ),
    ).toEqual(initialChecked())
  })

  it('survives storage that throws on write', () => {
    expect(() =>
      saveChecked(
        {
          setItem: () => {
            throw new Error('quota')
          },
        },
        '2026-10-03',
        initialChecked(),
      ),
    ).not.toThrow()
    expect(() => saveChecked(null, '2026-10-03', initialChecked())).not.toThrow()
  })
})

describe('engine client', () => {
  const ok = (body: unknown): typeof fetch => async () => new Response(JSON.stringify(body), { status: 200 })

  it('fetchSources returns the JSON body and rejects when unreachable', async () => {
    expect(await fetchSources({ fetchImpl: ok(SOURCES) })).toEqual(SOURCES)
    const down: typeof fetch = async () => {
      throw new TypeError('network down')
    }
    await expect(fetchSources({ fetchImpl: down })).rejects.toThrow()
    await expect(fetchSources({ fetchImpl: async () => new Response('x', { status: 500 }) })).rejects.toThrow()
    await expect(fetchSources({ fetchImpl: ok([1, 2]) })).rejects.toThrow()
  })

  it('and the rejected case ends in numbers-free text, not literals', async () => {
    const targets = await fetchSources({ fetchImpl: async () => new Response('', { status: 503 }) })
      .then(extractCwiTargets)
      .catch(() => NO_TARGETS)
    expect(nataGoalText(targets)).not.toMatch(/\d/)
  })

  it('fetchNodeLatest follows the NodeLatest contract', async () => {
    const none = await fetchNodeLatest({ fetchImpl: ok({ reading: null, labels: ['no field recording yet'], series: [], file: null }) })
    expect(none).toEqual({ reading: null, file: null, labels: ['no field recording yet'] })
    expect(tubDisplay(none).kind).toBe('none')

    const live = await fetchNodeLatest({ fetchImpl: ok({ ...reading({ tub_temp_c: 9.8 }), series: [], file: null }) })
    expect(tubDisplay(live).kind).toBe('reading')
    expect(live.labels).toEqual(['field node recording'])
  })

  it('parseNodeLatest rejects other shapes', () => {
    expect(parseNodeLatest(null)).toBeNull()
    expect(parseNodeLatest({ reading: 'x', labels: [] })).toBeNull()
    expect(parseNodeLatest({ reading: {}, labels: [] })).toBeNull() // no ts
    expect(parseNodeLatest({ labels: [1, 'a'] })).toEqual({ reading: null, file: null, labels: ['a'] })
  })
})
