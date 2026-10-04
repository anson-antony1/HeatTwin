import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { speakSentence, type SpeakDeps } from '../speak'

// Playback of an approved sentence: the browser's voice by default; the engine's ElevenLabs voice only if the engine has a key.

class FakeUtterance {
  text: string
  lang = ''
  constructor(text: string) {
    this.text = text
  }
}

function synth() {
  return { speak: vi.fn(), cancel: vi.fn() } as unknown as SpeechSynthesis & { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
}

function deps(over: Partial<SpeakDeps> = {}): SpeakDeps {
  return { synth: synth(), elevenlabs: vi.fn(async () => false), fetchAudio: vi.fn(async () => null), play: vi.fn(async () => {}), ...over }
}

describe('speakSentence', () => {
  beforeEach(() => vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance))
  afterEach(() => vi.unstubAllGlobals())

  it('uses the browser voice when the engine has no ElevenLabs key, and never asks the engine for audio', async () => {
    const d = deps()
    expect(await speakSentence('Estimate, planning only.', d)).toBe('browser')
    expect((d.synth as unknown as { speak: ReturnType<typeof vi.fn> }).speak).toHaveBeenCalledTimes(1)
    const u = (d.synth as unknown as { speak: ReturnType<typeof vi.fn> }).speak.mock.calls[0][0] as FakeUtterance
    expect(u.text).toBe('Estimate, planning only.')
    expect(d.fetchAudio).not.toHaveBeenCalled()
  })

  it('uses the engine voice only when it has a key, then does not also speak in the browser', async () => {
    const d = deps({ elevenlabs: vi.fn(async () => true), fetchAudio: vi.fn(async () => new Blob(['mp3'])) })
    expect(await speakSentence('Hello.', d)).toBe('elevenlabs')
    expect(d.play).toHaveBeenCalledTimes(1)
    expect((d.synth as unknown as { speak: ReturnType<typeof vi.fn> }).speak).not.toHaveBeenCalled()
  })

  it('falls back to the browser voice when the engine voice fails (503, blocked autoplay)', async () => {
    let d = deps({ elevenlabs: vi.fn(async () => true), fetchAudio: vi.fn(async () => null) })
    expect(await speakSentence('Hello.', d)).toBe('browser')
    d = deps({ elevenlabs: vi.fn(async () => true), fetchAudio: vi.fn(async () => new Blob(['mp3'])), play: vi.fn(async () => { throw new Error('NotAllowedError') }) })
    expect(await speakSentence('Hello.', d)).toBe('browser')
  })

  it('says nothing for empty text, and reports "none" when no voice exists', async () => {
    const d = deps()
    expect(await speakSentence('   ', d)).toBe('none')
    expect(await speakSentence('Hello.', deps({ synth: null }))).toBe('none')
  })

  it('cancels what is being said before the next sentence', async () => {
    const d = deps()
    await speakSentence('One.', d)
    expect((d.synth as unknown as { cancel: ReturnType<typeof vi.fn> }).cancel).toHaveBeenCalled()
  })
})
