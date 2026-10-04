import { describe, expect, it } from 'vitest'
import { interpretation, interpreterName } from '../interpretation'
import { PLAN } from './helpers'

const drafted = (drills: typeof PLAN.drills) => ({ plan: { ...PLAN, drills } })

describe('interpretation line', () => {
  it('lists a new plan when there is no plan in memory', () => {
    const line = interpretation(drafted(PLAN.drills.slice(0, 2)), null)
    expect(line).toHaveLength(1)
    expect(line[0]).toContain(PLAN.drills[0].name)
  })
  it('describes edits against the plan in memory', () => {
    const [first, ...rest] = PLAN.drills
    const longer = { ...first, duration_min: first.duration_min + 20 }
    const added = { ...first, id: 'zz', name: 'Stretching', duration_min: 10, intensity: 'light' as const }
    const line = interpretation(drafted([longer, ...rest.slice(1), added]), PLAN)
    expect(line).toContain(`${first.name} ${first.duration_min} min → ${first.duration_min + 20} min`)
    expect(line).toContain(`Remove ${rest[0].name}`)
    expect(line.some((l) => l.startsWith('Add Stretching'))).toBe(true)
  })
  it('says when nothing changed', () => {
    expect(interpretation(drafted(PLAN.drills), PLAN)).toEqual(['No change to the plan'])
  })
  it('names the interpreter', () => {
    expect(interpreterName({ model: 'gemini-3.1-flash-lite' })).toBe('Gemini')
    expect(interpreterName({ model: 'local-rules + embedding intensity' })).toBe('Offline parser')
  })
})
