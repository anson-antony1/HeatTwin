import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HELD_MESSAGE, geminiConfigured, parsePlanAuto, pickOption, provenanceLabels, runVoiceFlow, type FlowDeps } from '../voiceFlow'
import type { DecideResult, GuardResult, VoiceAnswer } from '../engineApi'
import type { PlanDraft } from '../llmPlan'
import { dockSheet } from '../../lib/dockSheet'
import { PLAN } from './helpers'

// The free voice path (data/voiceFlow.ts): transcript → /voice/decide → plan draft | engine sentence | "Did you mean …?".

const SAY = 'Practice hours: 15:00 WBGT 86 °F, zone 2. Source: fixture.'
const ANSWER: VoiceAnswer = { intent: 'field_conditions', say: SAY, numbers: ['15:00', '86', '2'], data: {}, labels: ['estimate — planning only', 'forecast is fixture'] }
const OK: GuardResult = { ok: true, redacted_text: SAY, hits: [], blocked_by: [] }
const DRAFT: PlanDraft = {
  plan: PLAN,
  transcript: 'x',
  assumptions: [],
  unclear: [],
  total_min: 10,
  needs_confirmation: true,
  labels: ["parsed locally from the coach's words (no AI service) — coach must confirm"],
  model: 'local-rules + embedding intensity',
}

function routed(over: Partial<DecideResult> = {}): DecideResult {
  return {
    transcript: 'x',
    intent: 'field_conditions',
    slots: {},
    unresolved: [],
    abstain: false,
    asking: null,
    did_you_mean: [],
    decisions: {},
    source: 'local',
    backend: 'fastembed:BAAI/bge-small-en-v1.5',
    labels: [],
    ...over,
  }
}

function deps(over: Partial<FlowDeps> = {}): FlowDeps {
  return {
    decide: vi.fn(async () => routed()),
    answer: vi.fn(async () => ANSWER),
    guard: vi.fn(async () => OK),
    parsePlan: vi.fn(async () => DRAFT),
    ...over,
  }
}

describe('voice flow: transcript → decision → engine sentence', () => {
  it('a question is answered with the ENGINE sentence, after /guard and the number check', async () => {
    const d = deps()
    const out = await runVoiceFlow('  what is the WBGT at four ', PLAN, {}, d)
    expect(out).toEqual({ kind: 'answer', transcript: 'what is the WBGT at four', intent: 'field_conditions', say: SAY, labels: ANSWER.labels, backend: 'fastembed:BAAI/bge-small-en-v1.5' })
    expect(d.decide).toHaveBeenCalledWith({ text: 'what is the WBGT at four', plan: PLAN, choices: {} }, undefined)
    expect(d.answer).toHaveBeenCalledWith({ intent: 'field_conditions', slots: {}, plan: PLAN, question: 'what is the WBGT at four' }, undefined)
    expect(d.guard).toHaveBeenCalledWith(SAY)
    expect(d.parsePlan).not.toHaveBeenCalled()
  })

  it('numbers the engine did not list hold the answer: nothing is shown or spoken', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const d = deps({ answer: vi.fn(async () => ({ ...ANSWER, numbers: ['15:00', '86'] })) })
    const out = await runVoiceFlow('wbgt', PLAN, {}, d)
    expect(out.kind).toBe('held')
    expect(JSON.stringify(out)).not.toContain(SAY)
    warn.mockRestore()
  })

  it('a sentence the guard assist blocks is held, and the reason names the layer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocked: GuardResult = { ok: false, redacted_text: '[removed: semantic]', hits: [], blocked_by: ['assist'], assist: { backend: 't', p_flag_max: 0.97, hits: [{ rule: 'semantic' }], calibrated: true, fallback: false } }
    const out = await runVoiceFlow('wbgt', PLAN, {}, deps({ guard: vi.fn(async () => blocked) }))
    expect(out.kind).toBe('held')
    expect(out.kind === 'held' && out.reason).toMatch(/flagged it by assist \(semantic\)/)
    expect(HELD_MESSAGE).not.toMatch(/\d/)
    warn.mockRestore()
  })

  it('a sentence already redacted by the engine is held even if /guard says ok', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const say = 'Isaiah: [removed: semantic]'
    const out = await runVoiceFlow('how is isaiah', PLAN, {}, deps({ answer: vi.fn(async () => ({ ...ANSWER, say, numbers: [] })) }))
    expect(out.kind).toBe('held')
    warn.mockRestore()
  })

  it('/guard unreachable → held (fail closed)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await runVoiceFlow('wbgt', PLAN, {}, deps({ guard: vi.fn(async () => { throw new TypeError('Failed to fetch') }) }))
    expect(out.kind).toBe('held')
    warn.mockRestore()
  })

  it('plan entry goes to the draft parser with the plan in use, and nothing is answered', async () => {
    const d = deps({ decide: vi.fn(async () => routed({ intent: 'plan_entry' })) })
    const out = await runVoiceFlow('add fifteen minutes of jumping jacks at the end', PLAN, {}, d)
    expect(out).toEqual({ kind: 'draft', transcript: 'add fifteen minutes of jumping jacks at the end', draft: DRAFT })
    expect(d.parsePlan).toHaveBeenCalledWith('add fifteen minutes of jumping jacks at the end', { current_plan: PLAN }, undefined)
    expect(d.answer).not.toHaveBeenCalled()
    // …and a draft always stops at the Confirm sheet
    expect(dockSheet({ errorMsg: null, draft: DRAFT, appliedDraft: null, opened: null, hasSim: true })).toBe('confirm')
  })
})

describe('"Did you mean …?" when the decision layer abstains', () => {
  const options = [
    { label: 'Plan summary', choices: { intent: 'plan_summary' }, p: 0.5 },
    { label: "One athlete's estimate", choices: { intent: 'athlete_status' }, p: 0.4 },
    { label: 'Third', choices: { intent: 'optimize' }, p: 0.1 },
  ]

  it('asks with the two most probable options and runs nothing', async () => {
    const d = deps({ decide: vi.fn(async () => routed({ abstain: true, asking: 'intent', did_you_mean: options, intent: 'athlete_status' })) })
    const out = await runVoiceFlow('who crosses first', PLAN, {}, d)
    expect(out.kind).toBe('choose')
    if (out.kind !== 'choose') return
    expect(out.asking).toBe('intent')
    expect(out.options.map((o) => o.label)).toEqual(['Plan summary', "One athlete's estimate"])
    expect(d.answer).not.toHaveBeenCalled()
    expect(d.parsePlan).not.toHaveBeenCalled()
    expect(dockSheet({ errorMsg: null, draft: null, appliedDraft: null, opened: null, hasSim: true, voice: 'choose' })).toBe('choose')
  })

  it('a tap re-asks with that choice added, and the answer follows', async () => {
    const decide = vi
      .fn()
      .mockResolvedValueOnce(routed({ abstain: true, asking: 'intent', did_you_mean: options.slice(0, 2) }))
      .mockResolvedValueOnce(routed({ intent: 'plan_summary' }))
    const d = deps({ decide })
    const first = await runVoiceFlow('who crosses first', PLAN, {}, d)
    if (first.kind !== 'choose') throw new Error('expected choose')
    const choices = pickOption(first, first.options[0])
    expect(choices).toEqual({ intent: 'plan_summary' })
    const second = await runVoiceFlow('who crosses first', PLAN, choices, d)
    expect(decide).toHaveBeenLastCalledWith({ text: 'who crosses first', plan: PLAN, choices: { intent: 'plan_summary' } }, undefined)
    expect(second.kind).toBe('answer')
  })

  it('a second question keeps the first answer (intent, then drill)', () => {
    const asked = { kind: 'choose' as const, transcript: 't', asking: 'drill' as const, options: [], choices: { intent: 'what_if' } }
    expect(pickOption(asked, { label: 'Water break after Team period', choices: { drill_id: 'b2' }, p: 0.5 })).toEqual({ intent: 'what_if', drill_id: 'b2' })
  })

  it('abstaining with nothing to offer is held, never acted on', async () => {
    const out = await runVoiceFlow('hmm', PLAN, {}, deps({ decide: vi.fn(async () => routed({ abstain: true, asking: 'intent', did_you_mean: [], intent: 'what_if' })) }))
    expect(out.kind).toBe('held')
  })
})

describe('which plan parser: Gemini only when the engine has it', () => {
  const realFetch = globalThis.fetch
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.useRealTimers()
  })

  function stub(configured: boolean) {
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url)
      calls.push(u)
      const body = u.endsWith('/plan/llm_status') ? { configured, provider: 'google-gemini', model: 'm' } : DRAFT
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    return calls
  }

  it('off by default → the engine\'s free parser (/plan/parse_local); on → Gemini (/plan/parse)', async () => {
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
    let calls = stub(false)
    expect(await geminiConfigured()).toBe(false)
    await parsePlanAuto('ten minute warmup', {})
    expect(calls.some((c) => c.endsWith('/plan/parse_local'))).toBe(true)
    expect(calls.some((c) => c.endsWith('/plan/parse'))).toBe(false)

    vi.setSystemTime(new Date('2026-10-04T12:05:00Z'))   // past the 30 s cache
    calls = stub(true)
    await parsePlanAuto('ten minute warmup', {})
    expect(calls.some((c) => c.endsWith('/plan/parse'))).toBe(true)
  })

  it('an unreachable status is "not configured" (free path), not an error', async () => {
    vi.setSystemTime(new Date('2026-10-04T13:00:00Z'))
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    expect(await geminiConfigured()).toBe(false)
  })
})

describe('provenance labels next to an answer', () => {
  it('keeps the short synthetic / fixture labels, drops the long settings label', () => {
    const labels = ['estimate — planning only', 'synthetic roster', 'forecast is fixture', 'AT-owned settings — planning limit 39.0 °C (default; default from NIOSH 2016), near-limit band 0.3 °C (default), clothing mode conservative (default)']
    expect(provenanceLabels(labels)).toEqual(['synthetic roster', 'forecast is fixture'])
  })
})
