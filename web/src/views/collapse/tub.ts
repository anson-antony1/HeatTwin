import type { NodeLatest } from '../../data/sourcesApi'
import { cToF } from '../../lib/heat'
import { fmtCF, type CwiTargets } from './targets'

// Tub water temperature for Collapse mode. The only source is a numeric `tub_temp_c` on the
// field node's latest reading (GET /node/latest). No probe, no number.

export const TUB_TITLE = 'Tub water temperature'
export const NO_PROBE_TEXT = 'no probe connected'

export type TubDisplay =
  | { kind: 'none'; full: string }
  | {
      kind: 'reading'
      c: number
      f: number
      fText: string
      cText: string
      ts: string
      labels: string[]
    }

export function tubDisplay(latest: NodeLatest | null | undefined): TubDisplay {
  const c = latest?.reading?.tub_temp_c
  if (latest?.reading && typeof c === 'number' && Number.isFinite(c)) {
    const f = cToF(c)
    return {
      kind: 'reading',
      c,
      f,
      fText: `${f.toFixed(1)} °F`,
      cText: `${c.toFixed(1)} °C`,
      ts: latest.reading.ts,
      labels: latest.labels,
    }
  }
  return { kind: 'none', full: `${TUB_TITLE}: ${NO_PROBE_TEXT}` }
}

/**
 * Compares a real reading with the KSI water limit from /sources (ksi_cwi.water_temp_c_max).
 * Null when there is no reading or no sourced limit. Wording states the comparison only.
 */
export function tubVerdict(d: TubDisplay, t: CwiTargets): { under: boolean; text: string } | null {
  if (d.kind !== 'reading' || t.tubWaterMaxC == null) return null
  const under = d.c < t.tubWaterMaxC
  return {
    under,
    text: `${under ? 'Under' : 'Not under'} the KSI water limit of ${fmtCF(t.tubWaterMaxC)}`,
  }
}

/** "3:02 PM", or the raw string when it does not parse. */
export function formatNodeClock(ts: string): string {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return ts
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** "just now" / "4 min ago" / "2 h ago" / "3 d ago"; null when the timestamp does not parse. */
export function formatAge(ts: string, nowMs: number): string | null {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) return null
  const s = Math.max(0, (nowMs - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

/** One line for the EMS hand-off text. */
export function tubHandoffLine(d: TubDisplay): string {
  if (d.kind === 'none') return d.full
  return `${TUB_TITLE}: ${d.fText} / ${d.cText} (field-node probe, reading at ${formatNodeClock(d.ts)})`
}
