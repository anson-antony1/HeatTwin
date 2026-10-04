import { describe, expect, it } from 'vitest'
import { dockSheet } from '../dockSheet'
import type { PlanDraft } from '../../data/llmPlan'
import { PLAN } from '../../data/__tests__/helpers'

const draft: PlanDraft = { plan: PLAN, transcript: 't', assumptions: [], unclear: [], total_min: 10, needs_confirmation: true, labels: [], model: 'local' }
const base = { errorMsg: null, draft: null, appliedDraft: null, opened: null, hasSim: true } as const

describe('which sheet the dock shows', () => {
  it('an error wins; then "Did you mean …?"; then an answer; then the plan draft', () => {
    expect(dockSheet({ ...base, errorMsg: 'x', voice: 'choose' })).toBe('error')
    expect(dockSheet({ ...base, voice: 'choose', draft })).toBe('choose')
    expect(dockSheet({ ...base, voice: 'answer' })).toBe('answer')
    expect(dockSheet({ ...base, voice: 'held' })).toBe('answer')
    expect(dockSheet({ ...base, draft })).toBe('confirm')
    expect(dockSheet({ ...base })).toBeNull()
  })

  it('a question answer does not disturb the result / typing sheets when there is none', () => {
    expect(dockSheet({ ...base, opened: 'typing', voice: null })).toBe('typing')
    expect(dockSheet({ ...base, opened: 'result', voice: null })).toBe('result')
  })
})
