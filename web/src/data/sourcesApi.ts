// Tiny typed client for GET /sources (constants.yaml as JSON) and GET /node/latest
// (CONTRACTS.md v1.3 `NodeLatest`). Nothing here invents a value: a missing or unreachable
// response is reported as an error (or `null` from the parsers), and callers show text
// without numbers instead of falling back to literals.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

const TIMEOUT_MS = 4000

/** constants.yaml as JSON: blocks like `ksi_cwi`, `nata_ehs`, `mhsaa_cwi_2026`, each with `status` and `source`. */
export type SourcesJson = Record<string, unknown>

/** One field-node reading. Only the fields the UI reads are typed; the engine may send more. */
export interface NodeReading {
  ts: string
  globe_c?: number
  air_c?: number
  rh_pct?: number
  air_source?: string
  node_wbgt_f?: number
  forecast_wbgt_f?: number
  field_minus_forecast_f?: number
  fhsaa_zone?: number
  globe_calibrated?: boolean
  /** Tub water probe in °C. Absent or null when no probe is connected. */
  tub_temp_c?: number | null
}

export interface NodeLatest {
  reading: NodeReading | null
  file?: string | null
  /** e.g. "no field recording yet" | "field node recording", "globe thermistor uncalibrated" */
  labels: string[]
}

export interface FetchOptions {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Overrides the engine base URL (tests). */
  base?: string
}

async function getJson(path: string, opts: FetchOptions): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  const r = await f(`${opts.base ?? ENGINE}${path}`, { signal })
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`)
  return r.json()
}

/** GET /sources. Throws when the engine is unreachable or the body is not a JSON object. */
export async function fetchSources(opts: FetchOptions = {}): Promise<SourcesJson> {
  const j = await getJson('/sources', opts)
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error('/sources: unexpected body')
  return j as SourcesJson
}

/** Validates a /node/latest body. Returns null when the shape is not NodeLatest. */
export function parseNodeLatest(j: unknown): NodeLatest | null {
  if (typeof j !== 'object' || j === null) return null
  const o = j as Record<string, unknown>
  const labels = Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === 'string') : []
  const r = o.reading
  if (r === null || r === undefined) return { reading: null, file: typeof o.file === 'string' ? o.file : null, labels }
  if (typeof r !== 'object' || Array.isArray(r)) return null
  const reading = r as Record<string, unknown>
  if (typeof reading.ts !== 'string') return null
  return { reading: reading as unknown as NodeReading, file: typeof o.file === 'string' ? o.file : null, labels }
}

/** GET /node/latest. Throws when unreachable or malformed. `reading` is null when no node data exists. */
export async function fetchNodeLatest(opts: FetchOptions = {}): Promise<NodeLatest> {
  const parsed = parseNodeLatest(await getJson('/node/latest', opts))
  if (!parsed) throw new Error('/node/latest: unexpected body')
  return parsed
}
