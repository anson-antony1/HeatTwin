import { voiceStatus } from '../data/engineApi'

// Playback of an APPROVED sentence (guard + number check passed — data/voiceReply.ts). The browser's speechSynthesis is the
// default and costs nothing; the engine's ElevenLabs voice is used only when the engine says a key is set (GET /voice/status
// → tts.elevenlabs). A failure of the engine voice falls back to the browser voice; nothing here ever invents text.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

export type Spoken = 'elevenlabs' | 'browser' | 'none'

export interface SpeakDeps {
  synth: SpeechSynthesis | null
  /** True when the engine has an ElevenLabs key (cached for a minute). */
  elevenlabs: () => Promise<boolean>
  /** The engine's /voice/tts (re-guards the text); null on 422/503/network. */
  fetchAudio: (text: string) => Promise<Blob | null>
  play: (blob: Blob) => Promise<void>
}

let statusCache: { at: number; elevenlabs: boolean } | null = null
let audio: HTMLAudioElement | null = null

async function elevenlabsConfigured(): Promise<boolean> {
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.elevenlabs
  let on = false
  try {
    on = (await voiceStatus()).tts.elevenlabs
  } catch {
    on = false
  }
  statusCache = { at: Date.now(), elevenlabs: on }
  return on
}

async function fetchAudio(text: string): Promise<Blob | null> {
  try {
    const r = await fetch(`${ENGINE}/voice/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(20_000),
    })
    return r.ok ? await r.blob() : null
  } catch {
    return null
  }
}

async function play(blob: Blob): Promise<void> {
  audio?.pause()
  const url = URL.createObjectURL(blob)
  audio = new Audio(url)
  audio.onended = () => URL.revokeObjectURL(url)
  await audio.play()
}

const defaults = (): SpeakDeps => ({
  synth: typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null,
  elevenlabs: elevenlabsConfigured,
  fetchAudio,
  play,
})

export function speechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function stopSpeaking(synth: SpeechSynthesis | null = defaults().synth): void {
  synth?.cancel()
  audio?.pause()
  audio = null
}

/** Speak one approved sentence. Returns which voice was used ("none": nothing available — the sentence stays on screen). */
export async function speakSentence(text: string, deps: SpeakDeps = defaults()): Promise<Spoken> {
  const say = text.trim()
  if (!say) return 'none'
  stopSpeaking(deps.synth)
  if (await deps.elevenlabs()) {
    const blob = await deps.fetchAudio(say)
    if (blob) {
      try {
        await deps.play(blob)
        return 'elevenlabs'
      } catch {
        /* autoplay blocked or a decode error: use the browser voice */
      }
    }
  }
  if (!deps.synth) return 'none'
  const u = new SpeechSynthesisUtterance(say)
  u.lang = 'en-US'
  deps.synth.speak(u)
  return 'browser'
}
