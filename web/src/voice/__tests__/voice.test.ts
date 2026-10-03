import { describe, expect, it, vi } from 'vitest'
import planFile from '../../../../fixtures/plan.json'
import rosterFile from '../../../../fixtures/roster.json'
import type { PracticePlan } from '../../data/llmPlan'
import { createVoiceApi, VoiceApiError, type GuardResult, type VoiceAnswer, type VoiceApi, type VoiceIntent } from '../engineApi'
import { LOCAL_ROUTER_MODEL, resolveDrill, routeLocal, type RosterName } from '../localAnswer'
import { checkNumbers, numberTokens } from '../numbers'
import { approveAnswer, runTurn, speakApproved, VOICE_NEEDS_ENGINE, type SpeechOut, type Turn } from '../pipeline'
import { blobToBase64 } from '../usePushToTalk'

const FIXTURE_PLAN = planFile.plan as unknown as PracticePlan
const FIXTURE_ROSTER = rosterFile.roster as RosterName[]

const okGuard = async (text: string): Promise<GuardResult> => ({ ok: true, redacted_text: text, hits: [] })

function answer(say: string, numbers: string[], extra: Partial<VoiceAnswer> = {}): VoiceAnswer {
  return { intent: 'athlete_status', say, numbers, data: {}, labels: ['estimate — planning only'], ...extra }
}

function fakeApi(over: Partial<VoiceApi> = {}): VoiceApi {
  return {
    intent: vi.fn(async () => {
      throw new VoiceApiError(503, '/voice/intent → HTTP 503: no GEMINI_API_KEY')
    }),
    answer: vi.fn(async () => answer('Isaiah: estimated peak 39.4 °C.', ['39.4'])),
    guard: vi.fn(okGuard),
    tts: vi.fn(async () => new Blob(['mp3'], { type: 'audio/mpeg' })),
    ...over,
  }
}

function fakeSpeech(over: Partial<SpeechOut> = {}): SpeechOut & { fallback: ReturnType<typeof vi.fn> } {
  return {
    tts: vi.fn(async () => new Blob(['mp3'], { type: 'audio/mpeg' })),
    play: vi.fn(async () => {}),
    fallback: vi.fn(),
    ...over,
  } as SpeechOut & { fallback: ReturnType<typeof vi.fn> }
}

// ── per-answer number check ──

describe('per-answer number check', () => {
  it('passes when every number in say is in numbers', () => {
    const say = '16 of 16 athletes are estimated over the 39.0 °C planning line; the highest estimate is 41.65 °C.'
    expect(checkNumbers(say, ['16', '16', '39.0', '41.65'])).toEqual({ ok: true, missing: [] })
  })

  it('fails on an extra number not in this answer', () => {
    const r = checkNumbers('Peak 41.65 °C, first over at minute 12.', ['41.65'])
    expect(r.ok).toBe(false)
    expect(r.missing).toEqual(['12'])
  })

  it('is per answer: numbers from another answer do not count', () => {
    const first = answer('Line is 39.0 °C.', ['39.0'])
    const second = answer('Peak 41.2 °C at the 39.0 °C line.', ['41.2'])
    expect(checkNumbers(first.say, first.numbers).ok).toBe(true)
    expect(checkNumbers(second.say, second.numbers).missing).toEqual(['39.0'])
  })

  it('handles decimals: 39.0 ↔ 39 is the same value, but there is no rounding tolerance', () => {
    expect(checkNumbers('over the 39.0 °C line', ['39']).ok).toBe(true)
    expect(checkNumbers('over the 39 °C line', ['39.0']).ok).toBe(true)
    expect(checkNumbers('peak 41.2 °C', ['41.25']).missing).toEqual(['41.2'])
    expect(checkNumbers('peak 41.25 °C', ['41.2']).missing).toEqual(['41.25'])
  })

  it('keeps the sign, and accepts a negative written as a word', () => {
    expect(checkNumbers('a change of -0.23 °C', ['0.23']).missing).toEqual(['-0.23'])
    expect(checkNumbers('a change of 0.23 °C', ['-0.23']).missing).toEqual(['0.23'])
    expect(checkNumbers('a change of -0.23 °C', ['-0.23']).ok).toBe(true)
    expect(checkNumbers('the average peak goes down 0.23 °C', ['-0.23']).ok).toBe(true)
    expect(checkNumbers('a change of minus 0.23 °C', ['0.23']).ok).toBe(true)
    expect(checkNumbers('it is 0.23 °C lower', ['-0.23']).ok).toBe(true)
    expect(checkNumbers('a change of minus 0.24 °C', ['-0.23']).missing).toEqual(['0.24'])
  })

  it('treats clock times as times', () => {
    expect(checkNumbers('Practice hours: 15:00 WBGT 86 °F, zone 2; 15:44 next.', ['15:00', '86', '2', '15:44']).ok).toBe(true)
    expect(checkNumbers('first over at 15:44', ['15', '44']).missing).toEqual(['15:44'])
    expect(checkNumbers('first over at 15:44', ['15:45']).missing).toEqual(['15:44'])
  })

  it('tokenises exactly like the engine (95th → 95, 10-15 → 10 and -15)', () => {
    expect(numberTokens('at the 95th percentile, 10-15 min, 15:00').map((t) => t.text)).toEqual(['95', '10', '-15', '15:00'])
  })

  it('fails closed when numbers is missing or malformed', () => {
    expect(checkNumbers('peak 41.2 °C', undefined).ok).toBe(false)
    expect(checkNumbers('peak 41.2 °C', 'nope').ok).toBe(false)
    expect(checkNumbers('No numbers here. Estimate, planning only.', undefined).ok).toBe(true)
  })
})

// ── approval: guard + numbers, before display or speech ──

describe('approval before display or speech', () => {
  it('approves a guarded answer whose numbers are all listed', async () => {
    const r = await approveAnswer(answer('Peak 39.4 °C.', ['39.4']), { guard: okGuard })
    expect(r).toEqual({ ok: true, say: 'Peak 39.4 °C.', labels: ['estimate — planning only'] })
  })

  it('holds when /guard is unreachable (fail closed)', async () => {
    const r = await approveAnswer(answer('Peak 39.4 °C.', ['39.4']), {
      guard: async () => {
        throw new VoiceApiError(0, "Can't reach the engine")
      },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/guard could not be reached/)
  })

  it('holds on a guard hit, and the reason does not quote the sentence', async () => {
    const r = await approveAnswer(answer('Devin is safe to keep going, peak 39.4 °C.', ['39.4']), {
      guard: async (t) => ({ ok: false, redacted_text: t.replace('safe', '[removed: reassurance]'), hits: [{ rule: 'reassurance', match: 'safe', start: 9, end: 13 }] }),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/reassurance/)
      expect(r.reason).not.toMatch(/safe|Devin|39\.4/)
    }
  })

  it('holds on an unlisted number without showing it', async () => {
    const r = await approveAnswer(answer('Peak 39.4 °C, 41.9 at worst.', ['39.4']), { guard: okGuard })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toMatch(/1 number in it is not in this answer's engine numbers/)
      expect(r.reason).not.toMatch(/41\.9/)
    }
  })

  it("holds a sentence the engine's guard already redacted, and an empty one", async () => {
    expect((await approveAnswer(answer('Devin is [removed: reassurance].', []), { guard: okGuard })).ok).toBe(false)
    expect((await approveAnswer(answer('  ', []), { guard: okGuard })).ok).toBe(false)
  })
})

describe('a whole turn', () => {
  const ctx = { plan: FIXTURE_PLAN, roster: FIXTURE_ROSTER }

  it('guard outage → HELD: say is never displayed and TTS is never called', async () => {
    const api = fakeApi({
      guard: vi.fn(async () => {
        throw new VoiceApiError(0, "Can't reach the engine")
      }),
    })
    const speech = fakeSpeech()
    const seen: Turn[] = []
    const t = await runTurn({ kind: 'text', text: 'How hot does Isaiah get?' }, ctx, { api, speech }, (x) => seen.push(x))
    expect(t.held).toMatch(/guard could not be reached/)
    expect(t.answer).toBeUndefined()
    expect(seen.every((x) => x.answer === undefined)).toBe(true)
    expect(JSON.stringify(seen)).not.toContain('39.4')
    expect(speech.tts).not.toHaveBeenCalled()
    expect(speech.play).not.toHaveBeenCalled()
    expect(speech.fallback).not.toHaveBeenCalled()
  })

  it('guard hit → HELD, nothing spoken', async () => {
    const api = fakeApi({
      answer: vi.fn(async () => answer('Devin looks fine, peak 39.4 °C.', ['39.4'])),
      guard: vi.fn(async (t: string) => ({ ok: false, redacted_text: t, hits: [{ rule: 'reassurance', match: 'fine', start: 12, end: 16 }] })),
    })
    const speech = fakeSpeech()
    const seen: Turn[] = []
    const t = await runTurn({ kind: 'text', text: 'Is Devin safe?' }, ctx, { api, speech }, (x) => seen.push(x))
    expect(t.held).toMatch(/reassurance/)
    expect(JSON.stringify(seen)).not.toContain('looks fine')
    expect(speech.tts).not.toHaveBeenCalled()
    expect(speech.fallback).not.toHaveBeenCalled()
  })

  it('TTS failure (503, no key) → speechSynthesis fallback with the approved text only', async () => {
    const say = 'Isaiah: estimated peak 39.4 °C.'
    const api = fakeApi({ answer: vi.fn(async () => answer(say, ['39.4'])) })
    const speech = fakeSpeech({
      tts: vi.fn(async () => {
        throw new VoiceApiError(503, '/voice/tts → HTTP 503: no ELEVENLABS_API_KEY')
      }),
    })
    const t = await runTurn({ kind: 'text', text: 'How hot does Isaiah get?' }, ctx, { api, speech })
    expect(t.answer?.say).toBe(say)
    expect(t.spoken).toBe('browser')
    expect(speech.fallback).toHaveBeenCalledTimes(1)
    expect(speech.fallback).toHaveBeenCalledWith(say)
  })

  it('TTS network failure or blocked playback → fallback; a TTS guard refusal (422) → not spoken at all', async () => {
    const approved = { ok: true as const, say: 'Peak 39.4 °C.', labels: [] }
    const offline = fakeSpeech({ tts: vi.fn(async () => Promise.reject(new VoiceApiError(0, 'offline'))) })
    expect(await speakApproved(approved, offline)).toBe('browser')
    expect(offline.fallback).toHaveBeenCalledWith('Peak 39.4 °C.')
    const blocked = fakeSpeech({ play: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) })
    expect(await speakApproved(approved, blocked)).toBe('browser')
    const refused = fakeSpeech({ tts: vi.fn(async () => Promise.reject(new VoiceApiError(422, 'guard'))) })
    expect(await speakApproved(approved, refused)).toBe('held_by_tts_guard')
    expect(refused.fallback).not.toHaveBeenCalled()
  })

  it('TTS success plays the engine audio and does not use the fallback', async () => {
    const speech = fakeSpeech()
    const t = await runTurn({ kind: 'text', text: 'How hot does Isaiah get?' }, ctx, { api: fakeApi(), speech })
    expect(t.spoken).toBe('tts')
    expect(speech.tts).toHaveBeenCalledWith('Isaiah: estimated peak 39.4 °C.')
    expect(speech.play).toHaveBeenCalledTimes(1)
    expect(speech.fallback).not.toHaveBeenCalled()
  })

  it('typed text with no intent service (503) routes locally and sends the plan on screen to /voice/answer', async () => {
    const api = fakeApi()
    const t = await runTurn({ kind: 'text', text: 'How hot does Isaiah get?' }, ctx, { api, speech: null })
    expect(t.tool?.router).toBe('local')
    expect(t.tool?.why).toMatch(/503/)
    expect(api.answer).toHaveBeenCalledWith({ intent: 'athlete_status', slots: { athlete_id: 'a07' }, plan: FIXTURE_PLAN })
    expect(t.spoken).toBe('not_spoken')
  })

  it('typed text with the engine unreachable also routes locally', async () => {
    const api = fakeApi({ intent: vi.fn(async () => Promise.reject(new VoiceApiError(0, 'down'))) })
    const t = await runTurn({ kind: 'text', text: 'Fix the plan.' }, ctx, { api, speech: null })
    expect(t.tool).toMatchObject({ router: 'local', intent: 'optimize', slots: { preset: 'max_load' }, why: 'engine unreachable' })
  })

  it('typed text uses the Gemini intent when the engine has it', async () => {
    const vi_: VoiceIntent = { transcript: 'how hot does isaiah get', intent: 'athlete_status', slots: { athlete_id: 'a07' }, unresolved: [], labels: [], model: 'gemini-x' }
    const api = fakeApi({ intent: vi.fn(async () => vi_) })
    const t = await runTurn({ kind: 'text', text: 'How hot does Isaiah get?' }, ctx, { api, speech: null })
    expect(api.intent).toHaveBeenCalledWith({ text: 'How hot does Isaiah get?', plan: FIXTURE_PLAN })
    expect(t.tool).toMatchObject({ router: 'gemini', intent: 'athlete_status', model: 'gemini-x' })
    expect(t.answer?.say).toBe('Isaiah: estimated peak 39.4 °C.')
  })

  it('spoken input with no intent service asks to type instead (no local guess, no answer call)', async () => {
    const api = fakeApi()
    const t = await runTurn({ kind: 'audio', audio_b64: 'UklGRg==', mime_type: 'audio/wav' }, ctx, { api, speech: fakeSpeech() })
    expect(t.note).toBe(VOICE_NEEDS_ENGINE)
    expect(api.answer).not.toHaveBeenCalled()
  })

  it('spoken input sends WAV base64 with the plan on screen', async () => {
    const vi_: VoiceIntent = { transcript: 'fix the plan', intent: 'optimize', slots: { preset: 'max_load' }, unresolved: [], labels: [], model: 'gemini-x' }
    const api = fakeApi({ intent: vi.fn(async () => vi_) })
    const t = await runTurn({ kind: 'audio', audio_b64: 'UklGRg==', mime_type: 'audio/wav' }, ctx, { api, speech: null })
    expect(api.intent).toHaveBeenCalledWith({ audio_b64: 'UklGRg==', mime_type: 'audio/wav', plan: FIXTURE_PLAN })
    expect(t.you).toBe('fix the plan')
  })
})

// ── typed engine client ──

describe('engine client', () => {
  it('posts to the v1.3 routes and maps errors to VoiceApiError with the HTTP status', async () => {
    const calls: [string, RequestInit | undefined][] = []
    const f = (async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      if (url.endsWith('/voice/intent')) return new Response(JSON.stringify({ detail: 'no GEMINI_API_KEY' }), { status: 503 })
      if (url.endsWith('/voice/tts')) return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      return new Response(JSON.stringify({ ok: true, redacted_text: 'x', hits: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const api = createVoiceApi(f, 'http://engine')
    await expect(api.intent({ text: 'hi' })).rejects.toMatchObject({ status: 503 })
    expect((await api.guard('x')).ok).toBe(true)
    expect((await api.tts('x')).size).toBe(2)
    expect(calls.map((c) => c[0])).toEqual(['http://engine/voice/intent', 'http://engine/guard', 'http://engine/voice/tts'])
    const g = createVoiceApi((async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch, 'http://engine')
    await expect(g.answer({ intent: 'unknown', slots: {} })).rejects.toMatchObject({ status: 0 })
  })

  it('asks /voice/answer in demo mode', async () => {
    let url = ''
    const f = (async (u: string) => {
      url = u
      return new Response(JSON.stringify(answer('x', [])), { status: 200 })
    }) as unknown as typeof fetch
    await createVoiceApi(f, '/engine').answer({ intent: 'plan_summary', slots: {} })
    expect(url).toBe('/engine/voice/answer?demo=1')
  })

  it('base64-encodes recorded WAV bytes', async () => {
    expect(await blobToBase64(new Blob([new Uint8Array([82, 73, 70, 70])]))).toBe('UklGRg==')
  })
})

// ── local router ──

describe('local router (typed text, no intent service)', () => {
  const plan: PracticePlan = {
    id: 'custom',
    site: { name: 'x', lat: 0, lon: 0, surface: 'grass' },
    start: '2026-10-04T15:30:00-04:00',
    drills: [
      { id: 'p1', name: 'Warm-up lap', duration_min: 8, intensity: 'light', gear: 'helmet', shade: false, is_break: false, priority: 2, movable: true },
      { id: 'p2', name: '7-on-7', duration_min: 20, intensity: 'hard', gear: 'helmet', shade: false, is_break: false, priority: 1, movable: true },
      { id: 'p3', name: 'Gassers', duration_min: 10, intensity: 'max', gear: 'none', shade: false, is_break: false, priority: 3, movable: true },
      { id: 'p4', name: 'Water', duration_min: 5, intensity: 'rest', gear: 'none', shade: true, is_break: true, priority: 1, movable: true },
      { id: 'p5', name: 'Team period', duration_min: 25, intensity: 'hard', gear: 'full_pads', shade: false, is_break: false, priority: 1, movable: true },
      { id: 'p6', name: 'Individual period', duration_min: 15, intensity: 'moderate', gear: 'full_pads', shade: false, is_break: false, priority: 2, movable: true },
    ],
  }
  const roster: RosterName[] = [
    { id: 'z1', name: 'Rosa Diaz' },
    { id: 'z2', name: 'Amir Khan' },
  ]

  it('resolves drill names against the plan given (no hard-coded ids)', () => {
    expect(routeLocal('What if we drop the gassers?', plan, roster).slots).toEqual({ drill_id: 'p3', change: 'remove' })
    expect(routeLocal('What if team period is helmets only?', plan, roster).slots).toEqual({ drill_id: 'p5', change: 'gear', gear: 'helmet' })
    expect(routeLocal('what if the warm up is in the shade', plan, roster).slots).toEqual({ drill_id: 'p1', change: 'shade', shade: true })
    // the same words on the fixture plan resolve to the fixture's own ids
    expect(routeLocal('What if we drop the gassers?', FIXTURE_PLAN, FIXTURE_ROSTER).slots.drill_id).toBe(
      FIXTURE_PLAN.drills.find((d) => /gassers/i.test(d.name))?.id,
    )
  })

  it('add_break leaves the minutes to the engine; a duration is only set when the coach typed one', () => {
    const r = routeLocal('Add a water break after team period', plan, roster)
    expect(r.intent).toBe('what_if')
    expect(r.slots).toEqual({ drill_id: 'p5', change: 'add_break' })
    expect(r.slots).not.toHaveProperty('duration_min')
    expect(routeLocal('What if we make 7-on-7 15 minutes?', plan, roster).slots).toEqual({ drill_id: 'p2', change: 'duration', duration_min: 15 })
  })

  it('resolves athlete names against the roster given', () => {
    const r = routeLocal("How hot does Amir's day get?", plan, roster)
    expect(r).toMatchObject({ intent: 'athlete_status', slots: { athlete_id: 'z2' }, model: LOCAL_ROUTER_MODEL })
    expect(routeLocal('How hot does Isaiah get?', plan, roster).intent).not.toBe('athlete_status') // not on this roster
  })

  it('returns unknown when nothing matches, and reports the name it could not match', () => {
    expect(routeLocal("What's for lunch?", plan, roster)).toMatchObject({ intent: 'unknown', slots: {}, unresolved: [] })
    const r = routeLocal('What if we drop the sled pushes?', plan, roster)
    expect(r.intent).toBe('unknown')
    expect(r.unresolved).toEqual(['sled pushes'])
  })

  it('does not guess between two equally good drills', () => {
    expect('ambiguous' in resolveDrill('the period', plan)).toBe(true)
    const r = routeLocal('What if we cut the period?', plan, roster)
    expect(r.intent).toBe('unknown')
    expect(r.unresolved[0]).toMatch(/Team period or Individual period|Individual period or Team period/)
  })
})
