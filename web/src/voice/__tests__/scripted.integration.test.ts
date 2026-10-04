import { describe, expect, it, vi } from 'vitest'
import planFile from '../../../../fixtures/plan.json'
import rosterFile from '../../../../fixtures/roster.json'
import type { PracticePlan } from '../../data/llmPlan'
import { createVoiceApi, type VoiceAnswer } from '../engineApi'
import type { RosterName } from '../localAnswer'
import { checkNumbers } from '../numbers'
import { approveAnswer, runTurn, speakApproved } from '../pipeline'
import { findReassurance, TEST_QUESTIONS } from '../testQuestions'

// Live check of the 8 scripted questions against a running engine, through the real flow:
//   typed text → /voice/intent (Gemini if the engine has a key; else 503 → local router)
//   → /voice/answer?demo=1 → /guard + per-answer numbers → (no speech here; /voice/tts checked separately).
// Runs only with VITE_HEATTWIN_LIVE=1. Engine URL: VITE_ENGINE_URL (default http://127.0.0.1:8000), e.g.
//   VITE_HEATTWIN_LIVE=1 VITE_ENGINE_URL=http://127.0.0.1:8012 npx vitest run src/voice
const BASE = (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? 'http://127.0.0.1:8000'
const PLAN = planFile.plan as unknown as PracticePlan
const ROSTER = rosterFile.roster as RosterName[]

describe.runIf(import.meta.env.VITE_HEATTWIN_LIVE === '1')('scripted questions against the live engine', () => {
  const api = createVoiceApi(fetch, BASE)

  for (const t of TEST_QUESTIONS) {
    it(t.q, async () => {
      const turn = await runTurn({ kind: 'text', text: t.q }, { plan: PLAN, roster: ROSTER }, { api, speech: null })
      expect(turn.note).toBeUndefined()
      expect(turn.tool?.intent).toBe(t.intent)
      if (t.drill) expect(turn.tool?.slots.drill_id).toBe(PLAN.drills.find((d) => t.drill!.test(d.name))?.id)
      if (t.athlete) expect(turn.tool?.slots.athlete_id).toBe(ROSTER.find((a) => a.name.startsWith(t.athlete!))?.id)
      if (t.slots) expect(turn.tool?.slots).toMatchObject(t.slots)
      expect(turn.held).toBeUndefined()
      const say = turn.answer!.say
      expect(say.length).toBeGreaterThan(0)
      if (t.noReassurance) expect(findReassurance(say)).toBeNull()
      console.log(`Q: ${t.q}\n   → ${turn.tool?.router}: ${turn.tool?.intent} ${JSON.stringify(turn.tool?.slots)}\n   → ${say}`)
    }, 120_000)
  }

  it('the live /guard holds a reassuring sentence, and an unlisted number', async () => {
    const bad: VoiceAnswer = { intent: 'athlete_status', say: 'Devin is safe to keep practicing.', numbers: [], data: {}, labels: [] }
    expect((await approveAnswer(bad, api)).ok).toBe(false)
    const extra: VoiceAnswer = { intent: 'athlete_status', say: 'Peak 40.93 °C, 41.9 at worst.', numbers: ['40.93'], data: {}, labels: [] }
    expect(checkNumbers(extra.say, extra.numbers).ok).toBe(false)
    expect((await approveAnswer(extra, api)).ok).toBe(false)
  })

  it('live /voice/tts plays audio, or (503: no key) falls back to the browser voice with the approved text', async () => {
    const approved = { ok: true as const, say: 'Estimate, planning only.', labels: [] }
    const fallback = vi.fn()
    const spoken = await speakApproved(approved, { tts: (x) => api.tts(x), play: async () => {}, fallback })
    expect(['tts', 'browser']).toContain(spoken)
    if (spoken === 'browser') expect(fallback).toHaveBeenCalledWith('Estimate, planning only.')
  }, 60_000)
})
