import { beforeEach, describe, expect, it, vi } from 'vitest'
import { approveAnswer, checkNumbers, hasDigits, kelvin, type ReplyDeps } from '../voiceReply'
import type { GuardResult, VoiceAnswer } from '../engineApi'
import type { PlanDraft } from '../llmPlan'
import { dockSheet } from '../../lib/dockSheet'
import { PLAN } from './helpers'

const SAY = '16 of 16 athletes are estimated over the 39.0 °C planning line; the highest estimate is 41.65 °C. Moved it to 15:44.'
const ANSWER: VoiceAnswer = { intent: 'plan_summary', say: SAY, numbers: ['16', '16', '39.0', '41.65', '15:44'], data: {}, labels: ['estimate — planning only'] }
const OK: GuardResult = { ok: true, redacted_text: SAY, hits: [] }

describe('per-answer number check', () => {
  it('passes when every number and clock time in `say` is in this answer\'s numbers', () => {
    expect(checkNumbers(SAY, ANSWER.numbers)).toEqual({ ok: true, missing: [] })
  })

  it('fails on a number the engine did not write, with no rounding tolerance', () => {
    expect(checkNumbers('the highest estimate is 41.7 °C', ['41.65']).ok).toBe(false)
    expect(checkNumbers('down 0.23', ['-0.23']).ok).toBe(false)
    expect(checkNumbers('at 15:45', ['15:44']).missing).toEqual(['15:45'])
  })

  it('fails closed when `numbers` is missing or malformed', () => {
    expect(checkNumbers('39.0', undefined).ok).toBe(false)
    expect(checkNumbers('no numbers here', undefined).ok).toBe(true)
  })

  it('Gemini sentences with digits are not shown', () => {
    expect(hasDigits('Assumed a 4-minute water break')).toBe(true)
    expect(hasDigits('Assumed helmets for the warm-up')).toBe(false)
  })
})

describe('approval before display (guard + numbers)', () => {
  it('approves an engine sentence the guard passes', async () => {
    const ap = await approveAnswer(ANSWER, async () => OK)
    expect(ap).toEqual({ ok: true, say: SAY, labels: ['estimate — planning only'] })
  })

  it('holds the reply when /guard is unreachable', async () => {
    const ap = await approveAnswer(ANSWER, async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(ap.ok).toBe(false)
    expect(!ap.ok && ap.reason).toMatch(/could not be reached/)
  })

  it('holds the reply when the guard flags it or a number is not backed', async () => {
    const flagged = await approveAnswer(ANSWER, async () => ({ ok: false, redacted_text: '', hits: [{ rule: 'clearance' }] }))
    expect(flagged.ok).toBe(false)
    const unbacked = await approveAnswer({ ...ANSWER, numbers: ['16'] }, async () => OK)
    expect(unbacked.ok).toBe(false)
  })
})

describe('Kelvin reply store', () => {
  beforeEach(() => kelvin.reset())

  it('shows nothing new when /guard is down (held), and never the sentence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps: ReplyDeps = {
      answer: vi.fn(async () => ANSWER),
      guard: vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    }
    const key = {}
    const r = await kelvin.request({ key, intent: 'plan_summary', plan: PLAN, question: 'is everyone ok?' }, deps)
    expect(r.status).toBe('held')
    expect(r.say).toBeNull()
    expect(kelvin.get().say).toBeNull()
    expect(deps.answer).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'plan_summary', plan: PLAN, question: 'is everyone ok?' }),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('shows the approved engine sentence for its result', async () => {
    const key = {}
    const r = await kelvin.request({ key, intent: 'optimize', plan: PLAN, preset: 'max_load' }, { answer: async () => ANSWER, guard: async () => OK })
    expect(r.status).toBe('shown')
    expect(r.say).toBe(SAY)
    expect(kelvin.get().key).toBe(key)
  })
})

describe('Confirm before simulate (dock)', () => {
  const draft: PlanDraft = {
    plan: PLAN,
    transcript: 'warmup, water, team period',
    assumptions: [],
    unclear: [],
    total_min: 10,
    needs_confirmation: true,
    labels: ['parsed by AI — coach must confirm'],
    model: 'test',
  }

  it('a Gemini draft stops at the Confirm sheet until the coach confirms it', () => {
    expect(dockSheet({ errorMsg: null, draft, appliedDraft: null, opened: null, hasSim: true })).toBe('confirm')
    expect(dockSheet({ errorMsg: null, draft, appliedDraft: draft, opened: null, hasSim: true })).toBeNull()
    expect(dockSheet({ errorMsg: null, draft: { ...draft, plan: { ...PLAN, drills: [] } }, appliedDraft: null, opened: null, hasSim: true })).toBe('review')
    expect(dockSheet({ errorMsg: 'x', draft, appliedDraft: null, opened: null, hasSim: true })).toBe('error')
  })
})
