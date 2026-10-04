import { useSession } from '../data/engine'
import { ZONES, ZONE_COLOR } from '../data/constants'
import { NumberTicker } from './NumberTicker'
import { useWeather } from '../data/weather'
import './FieldCard.css'

// Bottom-left card from the Figma: on-field conditions at a glance.
export function FieldCard() {
  const s = useSession()
  const weather = useWeather()
  const zoneIdx = ZONES.findIndex((z) => z.id === s.zone.id)
  return (
    <section className="field glass" aria-label="Field conditions">
      <div className="field__top">
        <span className="eyebrow">WBGT · field</span>
        <span className="field__src" title={weather.location?.name}>{weather.location ? 'NWS forecast' : 'Forecast'}</span>
      </div>
      <div className="field__value display-lg">
        <NumberTicker value={s.wbgtF} decimals={1} suffix="°F" />
      </div>
      <div className="field__zones" role="img" aria-label={`FHSAA zone: ${s.zone.label}`}>
        {ZONES.map((z, i) => (
          <span
            key={z.id}
            className={`field__zone ${i === zoneIdx ? 'is-on' : ''}`}
            style={{ background: ZONE_COLOR[z.id] }}
          />
        ))}
      </div>
      <div className="field__label">
        <span style={{ color: ZONE_COLOR[s.zone.id] }}>●</span> {s.zone.label}
      </div>
    </section>
  )
}
