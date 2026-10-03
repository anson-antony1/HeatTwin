import { describe, expect, it } from 'vitest'
import { AI_NO_PLAN, AI_UNREACHABLE, ENGINE_UNREACHABLE, GENERIC, MIC_BLOCKED, NO_KEY, planErrorText, TOO_SLOW } from '../errors'

// The voice dock shows plain words, never a raw ProxyError / ReadTimeout from the engine's HTTP client (S5).

describe('planErrorText', () => {
  it('turns the engine’s AI-network failures into plain words', () => {
    for (const raw of [
      'Gemini unreachable: ProxyError',
      'Gemini unreachable: ReadTimeout',
      'Gemini unreachable: ConnectionError',
      "HTTPSConnectionPool(host='generativelanguage.googleapis.com', port=443): Max retries exceeded (Caused by ProxyError('Unable to connect to proxy'))",
      'Gemini HTTP 503: model overloaded',
    ]) {
      const text = planErrorText(raw)
      expect(text).toBe(AI_UNREACHABLE)
      expect(text).not.toMatch(/ProxyError|ReadTimeout|HTTPS|Gemini/)
    }
    expect(AI_UNREACHABLE).toBe('Can’t reach the AI service — type the plan or try again.')
  })

  it('names an unreachable engine, a slow answer, a blocked mic and a missing key', () => {
    expect(planErrorText('Failed to fetch')).toBe(ENGINE_UNREACHABLE)
    expect(planErrorText("Can't reach the engine (/engine). Is it running?")).toBe(ENGINE_UNREACHABLE)
    expect(planErrorText('Internal Server Error')).toBe(ENGINE_UNREACHABLE)
    expect(planErrorText('signal timed out')).toBe(TOO_SLOW)
    expect(planErrorText('The engine took too long to answer.')).toBe(TOO_SLOW)
    expect(planErrorText('NotAllowedError: Permission denied')).toBe(MIC_BLOCKED)
    expect(planErrorText('GEMINI_API_KEY is not set (put it in .env at the repo root)')).toBe(NO_KEY)
  })

  it('says the AI could not make a plan when its output was unusable', () => {
    expect(planErrorText('Gemini output did not match the drill schema: duration_min')).toBe(AI_NO_PLAN)
    expect(planErrorText('Gemini returned no content (SAFETY)')).toBe(AI_NO_PLAN)
    expect(planErrorText('Gemini HTTP 400: bad request')).toBe(AI_NO_PLAN)
  })

  it('keeps a plain engine sentence, but never a raw exception', () => {
    expect(planErrorText('text is empty')).toBe('text is empty')
    expect(planErrorText("KeyError('drills')")).toBe(GENERIC)
    expect(planErrorText('')).toBe(GENERIC)
  })
})
