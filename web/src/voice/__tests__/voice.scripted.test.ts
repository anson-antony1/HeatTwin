import { describe, expect, it, vi } from 'vitest'
import planFile from '../../../../fixtures/plan.json'
import rosterFile from '../../../../fixtures/roster.json'
import type { PracticePlan } from '../../data/llmPlan'
import { VoiceApiError, type AnswerRequest, type GuardResult, type VoiceAnswer, type VoiceApi } from '../engineApi'
import { routeLocal, type RosterName } from '../localAnswer'
import { checkNumbers } from '../numbers'
import { runTurn, type SpeechOut } from '../pipeline'
import { findReassurance, TEST_QUESTIONS } from '../testQuestions'
import recorded from './recorded_answers.json'

// The 8 scripted questions, offline: the intent service is down (503) so typed text routes locally against the
// fixture plan and roster; /voice/answer is mocked with REAL engine replies recorded from /voice/answer?demo=1
// (recorded_answers.json, replay: true); /guard is mocked with the guard's reassurance rule; TTS is down (503).
// Every reply must be approved (guard ok + per-answer numbers) and spoken by the browser fallback with that text only.

const PLAN = planFile.plan as unknown as PracticePlan
const ROSTER = rosterFile.roster as RosterName[]
const ANSWERS = recorded.answers as { intent: string; slots: Record<string, unknown>; answer: VoiceAnswer }[]

const sameSlots = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())

const replayAnswer = async (req: AnswerRequest): Promise<VoiceAnswer> => {
  const row = ANSWERS.find((r) => r.intent === req.intent && sameSlots(r.slots, req.slots as Record<string, unknown>))
  if (!row) throw new VoiceApiError(404, `no recorded answer for ${req.intent} ${JSON.stringify(req.slots)}`)
  return row.answer
}

// Same idea as engine/guard.py's reassurance rule (enough for a mock).
const mockGuard = async (text: string): Promise<GuardResult> => {
  const m = /\b(safe|fine|okay|ok|cleared)\b/i.exec(text)
  return m ? { ok: false, redacted_text: text, hits: [{ rule: 'reassurance', match: m[0], start: m.index, end: m.index + m[0].length }] } : { ok: true, redacted_text: text, hits: [] }
}

describe('recorded engine answers', () => {
  it('are labelled as a replay of synthetic inputs', () => {
    expect(recorded.replay).toBe(true)
    expect(recorded.synthetic_inputs).toBe(true)
  })
  for (const r of ANSWERS) {
    it(`browser tokenizer agrees with the engine's numbers: ${r.intent} ${JSON.stringify(r.slots)}`, () => {
      expect(checkNumbers(r.answer.say, r.answer.numbers)).toEqual({ ok: true, missing: [] })
    })
  }
})

describe('the 8 scripted questions (local routing, mocked engine)', () => {
  for (const t of TEST_QUESTIONS) {
    it(t.q, async () => {
      // 1) routes to the expected intent, with names resolved on the plan/roster (no hard-coded ids)
      const r = routeLocal(t.q, PLAN, ROSTER)
      expect(r.intent).toBe(t.intent)
      if (t.drill) expect(r.slots.drill_id).toBe(PLAN.drills.find((d) => t.drill!.test(d.name))?.id)
      if (t.athlete) expect(r.slots.athlete_id).toBe(ROSTER.find((a) => a.name.startsWith(t.athlete!))?.id)
      if (t.slots) expect(r.slots).toMatchObject(t.slots)
      expect(r.slots).not.toHaveProperty('duration_min')

      // 2) the whole turn: approved, shown, and spoken with the approved text only
      const api: VoiceApi = {
        intent: vi.fn(async () => Promise.reject(new VoiceApiError(503, 'no GEMINI_API_KEY'))),
        answer: vi.fn(replayAnswer),
        guard: vi.fn(mockGuard),
        tts: vi.fn(async () => Promise.reject(new VoiceApiError(503, 'no ELEVENLABS_API_KEY'))),
      }
      const speech: SpeechOut = { tts: api.tts, play: vi.fn(async () => {}), fallback: vi.fn() }
      const turn = await runTurn({ kind: 'text', text: t.q }, { plan: PLAN, roster: ROSTER }, { api, speech })
      expect(turn.note).toBeUndefined()
      expect(turn.held).toBeUndefined()
      const say = turn.answer!.say
      const sent = (api.answer as ReturnType<typeof vi.fn>).mock.calls[0][0] as AnswerRequest
      expect(sent.plan).toBe(PLAN)
      const rec = await replayAnswer(sent)
      expect(say).toBe(rec.say)
      expect(checkNumbers(say, rec.numbers).ok).toBe(true)
      expect(sent.question).toBe(t.q) // v1.4: the coach's words go with every answer request
      if (t.noReassurance) expect(findReassurance(say)).toBeNull()
      expect(speech.fallback).toHaveBeenCalledTimes(1)
      expect(speech.fallback).toHaveBeenCalledWith(say)
    })
  }
})
