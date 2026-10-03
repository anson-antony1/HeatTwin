import { useCallback, useEffect, useRef, useState } from 'react'
import { toWav } from '../lib/useVoicePlan'
import { MAX_RECORD_SECONDS } from './config'
import { stopSpeaking } from './speech'

// Push-to-talk: hold to record the mic, release to send. The recording is converted to 16 kHz mono WAV with the same
// toWav() the plan-entry dock uses (Gemini doesn't accept Chrome's webm), then base64 for POST /voice/intent.

const MIN_MS = 400

export type PttState = 'idle' | 'starting' | 'recording' | 'converting'

/** Blob → base64 (no data: prefix). */
export async function blobToBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function usePushToTalk(onAudio: (audio_b64: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<PttState>('idle')
  const rec = useRef<MediaRecorder | null>(null)
  const starting = useRef(false)
  const releasedEarly = useRef(false)
  const startedAt = useRef(0)
  const timer = useRef<number | null>(null)
  const cb = useRef({ onAudio, onError })
  useEffect(() => {
    cb.current = { onAudio, onError }
  })

  const clearTimer = () => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
  }

  const start = useCallback(async () => {
    if (rec.current || starting.current) return
    starting.current = true
    releasedEarly.current = false
    stopSpeaking()
    setState('starting')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('unsupported')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true } })
      const mr = new MediaRecorder(stream)
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      mr.onstop = async () => {
        clearTimer()
        stream.getTracks().forEach((t) => t.stop())
        rec.current = null
        if (Date.now() - startedAt.current < MIN_MS || !chunks.length) {
          setState('idle')
          cb.current.onError('Too short — hold the button (or Space) while you speak.')
          return
        }
        setState('converting')
        try {
          const wav = await toWav(new Blob(chunks, { type: mr.mimeType }))
          cb.current.onAudio(await blobToBase64(wav))
        } catch (e) {
          cb.current.onError(`Couldn't read the recording (${(e as Error).message}).`)
        } finally {
          setState('idle')
        }
      }
      rec.current = mr
      startedAt.current = Date.now()
      mr.start()
      setState('recording')
      timer.current = window.setTimeout(() => mr.state === 'recording' && mr.stop(), MAX_RECORD_SECONDS * 1000)
      if (releasedEarly.current) mr.stop()
    } catch (e) {
      setState('idle')
      const denied = (e as Error).name === 'NotAllowedError'
      cb.current.onError(denied ? 'Microphone permission denied — type the question instead.' : 'Microphone unavailable — type the question instead.')
    } finally {
      starting.current = false
    }
  }, [])

  const stop = useCallback(() => {
    if (starting.current) {
      releasedEarly.current = true
      return
    }
    if (rec.current?.state === 'recording') rec.current.stop()
  }, [])

  useEffect(
    () => () => {
      clearTimer()
      if (rec.current?.state === 'recording') {
        rec.current.onstop = null
        rec.current.stream.getTracks().forEach((t) => t.stop())
        rec.current.stop()
      }
    },
    [],
  )

  return { state, recording: state === 'recording', start, stop }
}
