// "Talk to the Twin" configuration. Both values come from Vite env (web/.env.local), never from code.
//   VITE_ENGINE_URL              engine base URL (default http://localhost:8000)
//   VITE_ELEVENLABS_AGENT_ID     public ElevenLabs agent id; without it the panel runs in local text mode
export const ENGINE_URL: string = (import.meta.env.VITE_ENGINE_URL as string | undefined) ?? 'http://localhost:8000'
export const AGENT_ID: string | undefined = (import.meta.env.VITE_ELEVENLABS_AGENT_ID as string | undefined) || undefined
export const ESTIMATE_LABEL = 'estimate — planning only'
