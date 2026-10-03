import { useSession } from '../data/engine'
import { ZONES, ZONE_COLOR } from '../data/constants'
import { useSettings } from '../data/settingsStore'
import { cToF, msToMph, useWeather, zoneOf } from '../data/weatherStore'
import { NumberTicker } from './NumberTicker'
import './FieldCard.css'

// Bottom-left card from the Figma: conditions at the practice location right
// now — live NWS weather with our WBGT (via the engine) when available, else
// the replay's forecast value, labelled as such.
export function FieldCard() {
  const s = useSession()
  const w = useWeather()
  const { location } = useSettings()
  const live = w.source === 'nws_forecast' && w.now
  const wbgt = live ? w.now!.wbgt_f : s.wbgtF
  const zone = live ? zoneOf(w.now!.fhsaa_zone) : s.zone
  const zoneIdx = ZONES.findIndex((z) => z.id === zone.id)
  const place = w.place ?? location.name

  return (
    <section className="field glass" aria-label="Field conditions">
      <div className="field__top">
        <span className="eyebrow">WBGT · now</span>
        <span className={`field__src ${live ? 'is-live' : ''}`}>
          {live && <span className="field__live" aria-hidden="true" />}
          {live ? 'NWS live' : w.status === 'loading' ? 'Loading' : 'Forecast'}
        </span>
      </div>
      <div className="field__value display-lg">
        <NumberTicker value={wbgt} decimals={1} suffix="°F" />
      </div>
      <div className="field__zones" role="img" aria-label={`FHSAA zone: ${zone.label}`}>
        {ZONES.map((z, i) => (
          <span key={z.id} className={`field__zone ${i === zoneIdx ? 'is-on' : ''}`} style={{ background: ZONE_COLOR[z.id] }} />
        ))}
      </div>
      <div className="field__label">
        <span style={{ color: ZONE_COLOR[zone.id] }}>●</span> {zone.label}
      </div>
      {live && (
        <div className="field__meta num">
          {Math.round(cToF(w.now!.air_temp_c))}°F · {Math.round(w.now!.rh_pct)}% · {Math.round(msToMph(w.now!.wind_m_s))} mph
        </div>
      )}
      <div className="field__place" title={place}>
        {place}
      </div>
    </section>
  )
}
