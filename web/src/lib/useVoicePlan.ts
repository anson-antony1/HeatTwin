// React hook: the coach talks (or types) → a transcript → the engine's free decision layer → one of
//   · a DRAFT plan to confirm        (plan entry / edit: engine rules, or Gemini when the engine has a key)
//   · an ANSWER sentence             (a question: written by the ENGINE, guarded, number-checked — data/voiceFlow.ts)
//   · "Did you mean …?" (two options) when the router is not sure
//
//   const v = useVoicePlan({ current_plan: plan }, { getTranscript: () => captionsRef.current })
//   <button onClick={v.recording ? v.stop : v.start}>{v.recording ? 'Stop' : 'Ask'}</button>
//   {v.outcome?.kind === 'answer' && <p>{v.outcome.say}</p>}
//   {v.outcome?.kind === 'choose' && v.outcome.options.map(o => <button onClick={() => v.choose(o)}>{o.label}</button>)}
//   {v.draft && <PlanReview draft={v.draft} />}   // transcript, drills, assumptions, unclear; the coach confirms
//
// Transcript sources, in order: the browser's Web Speech API (`getTranscript`, free; lib/useLiveCaptions.ts) → the engine's
// offline Whisper (POST /voice/transcribe, laptop only) → Gemini hears the audio, only if the engine has a key. No paid API is
// needed for any step.
//
// Why WAV: Chrome's MediaRecorder only records webm/opus, which neither Whisper's loader nor Gemini lists. We decode the
// recording with Web Audio and re-encode it as 16 kHz mono 16-bit WAV (~32 kB per second of speech).
// Needs a secure context (https or localhost) for microphone access.

import { useCallback, useEffect, useRef, useState } from 'react'
import { parsePlanAudio, transcribeWav, type PlanContext, type PlanDraft } from '../data/llmPlan'
import { geminiConfigured, pickOption, runVoiceFlow, type Choices, type VoiceOutcome } from '../data/voiceFlow'
import type { DidYouMeanOption } from '../data/engineApi'
import { liveCaptionsSupported } from './useLiveCaptions'

export type VoiceState = 'idle' | 'recording' | 'processing' | 'done' | 'error'

const TARGET_RATE = 16000
const MAX_SECONDS = 180

export interface VoicePlanOptions {
  /** The Web Speech transcript of the recording that just ended (the latest text of lib/useLiveCaptions). */
  getTranscript?: () => string
  /** "Start a new plan" is on: send no plan as memory, so the words build a new plan from scratch. */
  fresh?: () => boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The recognizer delivers its last words just after the mic closes: wait (≤ 1 s) until the text stops changing. */
async function settleTranscript(get?: () => string): Promise<string> {
  if (!get || !liveCaptionsSupported) return ''
  let last = get()
  const t0 = Date.now()
  let stableSince = t0
  while (Date.now() - t0 < 1000) {
    await sleep(100)
    const now = get()
    if (now !== last) {
      last = now
      stableSince = Date.now()
    } else if (last && Date.now() - stableSince >= 300) break
  }
  return last.trim()
}

export const NO_RECOGNIZER =
  'No speech recognizer is available: this browser has no Web Speech API and the engine has no offline Whisper model. Type it instead.'

export function useVoicePlan(ctx: PlanContext = {}, opts: VoicePlanOptions = {}) {
  const [state, setState] = useState<VoiceState>('idle')
  const [outcome, setOutcome] = useState<VoiceOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })
  const lastText = useRef('')

  const cleanupTimer = () => {
    if (timer.current != null) window.clearInterval(timer.current)
    timer.current = null
  }

  const fail = (e: unknown) => {
    cleanupTimer()
    setError(e instanceof Error ? e.message : String(e))
    setState('error')
  }

  /** transcript → decide → draft | answer | choose. */
  const run = useCallback(async (text: string, choices: Choices) => {
    lastText.current = text
    const plan = ctxRef.current.current_plan
    if (!plan) throw new Error('There is no plan on screen to ask about.')
    const out = await runVoiceFlow(text, plan, choices, undefined, undefined, optsRef.current.fresh?.() ?? false)
    setOutcome(out)
    setState('done')
  }, [])

  const stop = useCallback(() => {
    if (rec.current && rec.current.state === 'recording') rec.current.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setOutcome(null)
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
          const blob = new Blob(chunks.current, { type: mr.mimeType })
          let transcript = await settleTranscript(optsRef.current.getTranscript)
          let wav: Blob | null = null
          if (!transcript) {
            // no browser recognizer: the engine's offline Whisper (laptop), if it is installed
            wav = await toWav(blob)
            try {
              transcript = (await transcribeWav(wav)).text.trim()
            } catch {
              transcript = ''
            }
          }
          if (!transcript) {
            if (await geminiConfigured()) {
              // last resort, only when the engine has a key: Gemini hears the audio and returns a plan draft
              wav ??= await toWav(blob)
              const { current_plan, ...rest } = ctxRef.current
              const draft = await parsePlanAudio(wav, optsRef.current.fresh?.() ? rest : { current_plan, ...rest })
              setOutcome({ kind: 'draft', transcript: draft.transcript, draft })
              setState('done')
              return
            }
            throw new Error(NO_RECOGNIZER)
          }
          await run(transcript, {})
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
  }, [run])

  /** Same flow for typed input (fallback when there's no mic or it's loud on the sideline). */
  const submitText = useCallback(
    async (text: string) => {
      setError(null)
      setOutcome(null)
      setState('processing')
      try {
        await run(text, {})
      } catch (e) {
        fail(e)
      }
    },
    [run],
  )

  /** The coach tapped an option of "Did you mean …?". */
  const choose = useCallback(
    async (option: DidYouMeanOption) => {
      const prev = outcome
      if (!prev || prev.kind !== 'choose') return
      setError(null)
      setOutcome(null)
      setState('processing')
      try {
        await run(lastText.current || prev.transcript, pickOption(prev, option))
      } catch (e) {
        fail(e)
      }
    },
    [outcome, run],
  )

  const reset = useCallback(() => {
    stop()
    setOutcome(null)
    setError(null)
    setState('idle')
  }, [stop])

  useEffect(() => () => {
    cleanupTimer()
    if (rec.current?.state === 'recording') rec.current.stop()
  }, [])

  const draft: PlanDraft | null = outcome?.kind === 'draft' ? outcome.draft : null
  return { state, recording: state === 'recording', seconds, outcome, draft, error, start, stop, submitText, choose, reset }
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
