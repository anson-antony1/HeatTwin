import { voiceApi } from './engineApi'
import type { SpeechOut } from './pipeline'

// Browser side of speech output. Only pipeline.speakApproved calls these, with an approved sentence.
//   ElevenLabs audio from the engine (/voice/tts) → an <audio> element; else the browser's own speechSynthesis.

let current: HTMLAudioElement | null = null
let currentUrl: string | null = null

function release() {
  if (currentUrl) URL.revokeObjectURL(currentUrl)
  current = null
  currentUrl = null
}

/** Stop whatever Kelvin is saying (a new question, or the mic opening, interrupts it). */
export function stopSpeaking(): void {
  current?.pause()
  release()
  try {
    globalThis.speechSynthesis?.cancel()
  } catch {
    /* no speech synthesis */
  }
}

async function play(audio: Blob): Promise<void> {
  stopSpeaking()
  const url = URL.createObjectURL(audio)
  const el = new Audio(url)
  current = el
  currentUrl = url
  el.onended = () => {
    if (current === el) release()
  }
  try {
    await el.play()
  } catch (e) {
    if (current === el) release()
    throw e
  }
}

function speakWithBrowser(text: string): void {
  const synth = globalThis.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  synth.speak(u)
}

export const browserSpeech: SpeechOut = {
  tts: (text) => voiceApi.tts(text),
  play,
  fallback: typeof globalThis.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speakWithBrowser : null,
}
