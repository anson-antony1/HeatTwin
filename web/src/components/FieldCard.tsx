import { useEffect } from 'react'
import { useSession } from '../data/engine'
import { engineMeta, useEngineMeta } from '../data/engineMeta'
import { zoneColor } from '../data/constants'
import { FHSAA_CITATION, zoneRule, zoneRuleText } from '../data/selectors'
import { NumberTicker } from './NumberTicker'
import { OfflineBadge } from './OfflineBadge'
import './FieldCard.css'

/** How often the sidebar re-reads GET /node/latest (a node may start recording mid-demo). UI refresh cadence. */
const NODE_POLL_MS = 30_000

// Sidebar card: the engine's forecast hour at the demo clock (WBGT, FHSAA zone
// and the zone's rule text from /sources), plus the field node from
// /node/latest. No placeholder numbers: with no recording it says so.
export function FieldCard() {
  const s = useSession()
  const meta = useEngineMeta()
  const w = s.weather
  const field = w?.source === 'field_node'
  const rules = meta.sources?.fhsaa_wbgt_zones?.zones
  const rule = zoneRule(rules, w?.fhsaa_zone)
  const node = meta.node
  const reading = node?.reading ?? null

  useEffect(() => {
    if (meta.link !== 'online') return
    const id = window.setInterval(() => void engineMeta.refreshNode(), NODE_POLL_MS)
    return () => window.clearInterval(id)
  }, [meta.link])

  return (
    <section className="field glass" aria-label="Field conditions">
      <div className="field__top">
        <span className="eyebrow">{field ? 'WBGT · field node' : 'Forecast WBGT (cached NWS)'}</span>
        {s.source === 'offline' && <OfflineBadge compact />}
      </div>
      <div className="field__value display-lg">
        {w ? <NumberTicker value={w.wbgt_f} decimals={1} suffix="°F" /> : <span className="faint">—</span>}
      </div>
      {rules && rules.length > 0 && (
        <div
          className="field__zones"
          role="img"
          aria-label={w ? `FHSAA zone ${w.fhsaa_zone}` : 'FHSAA zone unknown'}
          style={{ gridTemplateColumns: `repeat(${rules.length}, 1fr)` }}
        >
          {rules.map((z) => (
            <span
              key={z.zone}
              className={`field__zone ${z.zone === w?.fhsaa_zone ? 'is-on' : ''}`}
              style={{ background: zoneColor(z.zone) }}
              title={`Zone ${z.zone}: ${zoneRuleText(z)}`}
            />
          ))}
        </div>
      )}
      {w && (
        <div className="field__label">
          <span style={{ color: zoneColor(w.fhsaa_zone) }}>●</span> FHSAA zone {w.fhsaa_zone}
          {rule && <span className="field__rule"> · {zoneRuleText(rule)}</span>}
          {rule && <div className="field__cite faint">{FHSAA_CITATION}</div>}
        </div>
      )}

      <div className="field__node">
        <div className="eyebrow">Field node</div>
        {meta.link === 'offline' ? (
          <div className="faint">engine offline</div>
        ) : !node ? (
          <div className="faint">—</div>
        ) : !reading ? (
          <div className="faint">no field recording yet</div>
        ) : (
          <dl className="field__node-list num">
            <div>
              <dt>Node WBGT</dt>
              <dd>{reading.node_wbgt_f.toFixed(1)} °F</dd>
            </div>
            <div>
              <dt>Forecast WBGT</dt>
              <dd>{reading.forecast_wbgt_f.toFixed(1)} °F</dd>
            </div>
            <div>
              <dt>Field − forecast</dt>
              <dd>
                {reading.field_minus_forecast_f > 0 ? '+' : ''}
                {reading.field_minus_forecast_f.toFixed(1)} °F
              </dd>
            </div>
          </dl>
        )}
        {node && node.labels.length > 0 && reading && <div className="field__cite faint">{node.labels.join(' · ')}</div>}
      </div>
    </section>
  )
}
