// React hook: record the coach describing practice → WAV → engine → Gemini → draft plan.
//
//   const v = useVoicePlan()
//   <button onClick={v.recording ? v.stop : v.start}>{v.recording ? 'Stop' : 'Describe practice'}</button>
//   {v.state === 'processing' && 'Listening back…'}
//   {v.draft && <PlanReview draft={v.draft} />}   // show transcript, drills, assumptions, unclear; coach confirms
//   {v.error}
//
// Why WAV: Chrome's MediaRecorder only records webm/opus, which Gemini doesn't list as a supported audio type. We
// decode the recording with Web Audio and re-encode it as 16 kHz mono 16-bit WAV (~32 kB per second of speech).
// Needs a secure context (https or localhost) for microphone access.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parsePlanAudio, parsePlanText, type PlanContext, type PlanDraft } from '../data/llmPlan'

export type VoiceState = 'idle' | 'recording' | 'processing' | 'done' | 'error'

const TARGET_RATE = 16000
const MAX_SECONDS = 180

export function useVoicePlan(ctx: PlanContext = {}) {
  const [state, setState] = useState<VoiceState>('idle')
  const [draft, setDraft] = useState<PlanDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const cleanupTimer = () => {
    if (timer.current != null) window.clearInterval(timer.current)
    timer.current = null
  }

  const fail = (e: unknown) => {
    cleanupTimer()
    setError(e instanceof Error ? e.message : String(e))
    setState('error')
  }

  const stop = useCallback(() => {
    if (rec.current && rec.current.state === 'recording') rec.current.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setDraft(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true } })
      const mr = new MediaRecorder(stream)
      chunks.current = []
      mr.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      mr.onstop = async () => {
        cleanupTimer()
        stream.getTracks().forEach((t) => t.stop())
        setState('processing')
        try {
          const wav = await toWav(new Blob(chunks.current, { type: mr.mimeType }))
          setDraft(await parsePlanAudio(wav, ctxRef.current))
          setState('done')
        } catch (e) {
          fail(e)
        }
      }
      rec.current = mr
      mr.start()
      setSeconds(0)
      setState('recording')
      const t0 = Date.now()
      timer.current = window.setInterval(() => {
        const s = Math.floor((Date.now() - t0) / 1000)
        setSeconds(s)
        if (s >= MAX_SECONDS) mr.stop()
      }, 250)
    } catch (e) {
      fail(e) // NotAllowedError = microphone permission denied
    }
  }, [])

  /** Same flow for typed input (fallback when there's no mic or it's loud on the sideline). */
  const submitText = useCallback(async (text: string) => {
    setError(null)
    setDraft(null)
    setState('processing')
    try {
      setDraft(await parsePlanText(text, ctxRef.current))
      setState('done')
    } catch (e) {
      fail(e)
    }
  }, [])

  const reset = useCallback(() => {
    stop()
    setDraft(null)
    setError(null)
    setState('idle')
  }, [stop])

  useEffect(() => () => {
    cleanupTimer()
    if (rec.current?.state === 'recording') rec.current.stop()
  }, [])

  return { state, recording: state === 'recording', seconds, draft, error, start, stop, submitText, reset }
}

/** Any browser-recordable audio → 16 kHz mono 16-bit PCM WAV. */
export async function toWav(recording: Blob): Promise<Blob> {
  const decodeCtx = new AudioContext()
  const decoded = await decodeCtx.decodeAudioData(await recording.arrayBuffer())
  await decodeCtx.close()
  const frames = Math.ceil(decoded.duration * TARGET_RATE)
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE) // mixes down to mono and resamples
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const pcm = (await offline.startRendering()).getChannelData(0)

  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true) // PCM chunk size
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, TARGET_RATE, true)
  v.setUint32(28, TARGET_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  str(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}
