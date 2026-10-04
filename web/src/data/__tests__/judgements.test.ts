import { describe, expect, it } from 'vitest'
import { judgements } from '../judgements'

describe('Settings → judgement calls', () => {
  it('lists DESIGN and TODO entries (nested too) with their justification, justified first', () => {
    const j = judgements({
      shade_model: { status: 'DESIGN', note: 'n', justification: 'why shade' },
      gear_clothing: { status: 'VERIFIED', levels: { helmet: { status: 'DESIGN', justification: 'why helmet' }, none: { i_m: 0.42 } } },
      node_globe: { status: 'TODO', note: 'uncalibrated' },
      optimizer: { status: 'DESIGN', note: 'search settings' },
      fhsaa_wbgt_zones: { status: 'VERIFIED' },
    })
    expect(j.map((x) => x.path)).toEqual(['gear_clothing.levels.helmet', 'shade_model', 'node_globe', 'optimizer'])
    expect(j[0]).toMatchObject({ status: 'DESIGN', justification: 'why helmet' })
    expect(j.find((x) => x.path === 'node_globe')).toMatchObject({ status: 'TODO', note: 'uncalibrated' })
  })
  it('is empty without sources', () => {
    expect(judgements(null)).toEqual([])
  })
})
