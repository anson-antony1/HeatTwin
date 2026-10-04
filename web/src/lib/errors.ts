// Plain words for errors the voice dock shows while building a plan (engine
// /plan/parse*, Gemini behind it). Raw exception names from the engine's HTTP
// client ("Gemini unreachable: ProxyError", "ReadTimeout", …) never reach the
// screen; callers log the raw message to the console instead.

export const AI_UNREACHABLE = 'Can’t reach the AI service — type the plan or try again.'
export const ENGINE_UNREACHABLE = 'Can’t reach the HeatTwin engine — check that it is running, then try again.'
export const TOO_SLOW = 'That took too long to answer — try again, or type the plan.'
export const AI_NO_PLAN = 'The AI service couldn’t turn that into a plan — try again, or type the plan.'
export const GENERIC = 'Something went wrong — try again, or type the plan.'
export const MIC_BLOCKED = 'Microphone access was blocked. Allow it in the browser, or type the plan instead.'
export const NO_KEY = 'The engine has no Gemini key. Add GEMINI_API_KEY to .env at the repo root and restart the engine.'

/** Network failures between the engine and the AI service (requests exception names, upstream 5xx). */
const AI_NETWORK =
  /Gemini unreachable|ProxyError|ReadTimeout|ConnectTimeout|ConnectionError|SSLError|RemoteDisconnected|Max retries|HTTPSConnectionPool|NameResolution|getaddrinfo|Gemini HTTP 5\d\d/i
/** The browser could not reach the engine (or the dev proxy had nothing behind it). */
const ENGINE_NETWORK = /Failed to fetch|NetworkError|Load failed|reach the engine|ECONNREFUSED|^HTTP 50[02]: ?$|^Internal Server Error$|^Bad Gateway$/i
const TIMEOUT = /timed out|took too long|took longer|TimeoutError|signal is aborted/i
const AI_OUTPUT = /Gemini HTTP \d|Gemini returned no content|did not match the drill schema/i
/** Anything that still looks like a raw exception or stack trace. */
const RAW = /Traceback|\w+Error\(|\w+Exception\b|<urllib3|HTTPConnection/

/** The sentence the voice dock shows for an error message from the plan-entry flow. */
export function planErrorText(message: string): string {
  const m = message.trim()
  if (/permission|NotAllowed/i.test(m)) return MIC_BLOCKED
  if (/GEMINI_API_KEY/i.test(m)) return NO_KEY
  if (AI_NETWORK.test(m)) return AI_UNREACHABLE
  if (TIMEOUT.test(m)) return TOO_SLOW
  if (ENGINE_NETWORK.test(m)) return ENGINE_UNREACHABLE
  if (AI_OUTPUT.test(m)) return AI_NO_PLAN
  if (!m || RAW.test(m)) return GENERIC
  return m
}
