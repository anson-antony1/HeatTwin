import { useEffect, useRef, useState } from 'react'

// The browser's speech recognizer (Web Speech API: Chrome / Edge / Safari): instant captions while the coach talks, and the
// TRANSCRIPT the voice path routes (useVoicePlan reads it from `latest`). Silently absent elsewhere; then the engine's
// offline Whisper (POST /voice/transcribe) or, if the engine has a key, Gemini hears the recording instead.
// Note: Chrome's recognizer sends the audio to Google's free speech service; the engine's Whisper keeps it on the laptop.

interface RecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type RecognitionCtor = new () => RecognitionLike

function recognizer(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const liveCaptionsSupported = typeof window !== 'undefined' && recognizer() !== null

/** `latest` (optional) always holds the most recent caption text, including the words that arrive just after `active` turns false. */
export function useLiveCaptions(active: boolean, latest?: { current: string }) {
  const [text, setText] = useState('')
  const finalRef = useRef('')

  useEffect(() => {
    const Ctor = recognizer()
    if (!active || !Ctor) return
    finalRef.current = ''
    if (latest) latest.current = ''
    const rec = new Ctor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalRef.current += r[0].transcript + ' '
        else interim += r[0].transcript
      }
      const t = (finalRef.current + interim).trim()
      setText(t)
      if (latest) latest.current = t
    }
    rec.onerror = () => {}
    try {
      rec.start()
    } catch {
      /* already started */
    }
    // stop(), not abort(): the recognizer delivers its last words after the mic closes, and `latest` keeps them
    return () => {
      try {
        rec.stop()
      } catch {
        rec.abort()
      }
    }
  }, [active, latest])

  // Clear when a new recording starts.
  useEffect(() => {
    if (active) setText('') // eslint-disable-line react-hooks/set-state-in-effect
  }, [active])

  return text
}
