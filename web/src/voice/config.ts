// "Ask Kelvin" configuration. Same engine base URL as the rest of the web app (web/src/data/engineApi.ts):
//   VITE_ENGINE_URL   engine base URL; default '/engine' (the Vite dev proxy → http://127.0.0.1:8000)
// No API keys live in the browser: Gemini (intent) and ElevenLabs (TTS) keys stay on the engine.
export const ENGINE_URL: string = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

export const ESTIMATE_LABEL = 'estimate — planning only'

/** Longest push-to-talk recording we send for one question. */
export const MAX_RECORD_SECONDS = 30
