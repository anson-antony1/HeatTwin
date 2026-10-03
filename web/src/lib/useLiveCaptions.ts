import { useEffect, useRef, useState } from 'react'

// Instant captions while the coach talks, from the browser's speech
// recognizer (Chrome / Edge / Safari). Display only — the transcript that
// builds the plan comes from Gemini on the engine. Silently absent elsewhere.

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

export function useLiveCaptions(active: boolean) {
  const [text, setText] = useState('')
  const finalRef = useRef('')

  useEffect(() => {
    const Ctor = recognizer()
    if (!active || !Ctor) return
    finalRef.current = ''
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
      setText((finalRef.current + interim).trim())
    }
    rec.onerror = () => {}
    try {
      rec.start()
    } catch {
      /* already started */
    }
    return () => rec.abort()
  }, [active])

  // Clear when a new recording starts.
  useEffect(() => {
    if (active) setText('') // eslint-disable-line react-hooks/set-state-in-effect
  }, [active])

  return text
}
