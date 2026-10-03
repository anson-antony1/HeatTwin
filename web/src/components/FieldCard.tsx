import { useSession } from '../data/engine'
import { zoneColor } from '../data/constants'
import { NumberTicker } from './NumberTicker'
import { OfflineBadge } from './OfflineBadge'
import './FieldCard.css'

// Bottom-left card: the engine's forecast hour at the demo clock.
export function FieldCard() {
  const s = useSession()
  const w = s.weather
  const field = w?.source === 'field_node'
  return (
    <section className="field glass" aria-label="Field conditions">
      <div className="field__top">
        <span className="eyebrow">{field ? 'WBGT · field node' : 'Forecast WBGT (cached NWS)'}</span>
        {s.source === 'offline' && <OfflineBadge compact />}
      </div>
      <div className="field__value display-lg">
        {w ? <NumberTicker value={w.wbgt_f} decimals={1} suffix="°F" /> : <span className="faint">—</span>}
      </div>
      {w && (
        <div className="field__label">
          <span style={{ color: zoneColor(w.fhsaa_zone) }}>●</span> FHSAA zone {w.fhsaa_zone}
        </div>
      )}
    </section>
  )
}
