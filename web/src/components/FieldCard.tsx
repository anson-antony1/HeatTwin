import { useSession } from '../data/engine'
import { useEngineMeta } from '../data/engineMeta'
import { zoneColor } from '../data/constants'
import { FHSAA_CITATION, weatherSourceLabel, zoneRule, zoneRuleText, zoneShortText } from '../data/selectors'
import { NumberTicker } from './NumberTicker'
import { OfflineBadge } from './OfflineBadge'
import { fieldHour, useWeather } from '../data/weather'
import './FieldCard.css'

/** FHSAA Policy 41 has five WBGT zones (CONTRACTS WeatherHour.fhsaa_zone 1–5); /sources carries their rules. */
const ZONE_NUMBERS = [1, 2, 3, 4, 5]

// Bottom-left card from the Figma: on-field conditions at a glance. Every number is the engine's: the plan's
// forecast hour at the practice clock, or the engine's GET /weather hour for a location picked in Settings.
export function FieldCard() {
  const s = useSession()
  const meta = useEngineMeta()
  const weather = useWeather()
  const hour = fieldHour(weather, s.weather, s.plan?.start ?? null, s.minute)
  const rules = meta.sources?.fhsaa_wbgt_zones?.zones
  const zones = rules?.length ? rules.map((r) => r.zone) : ZONE_NUMBERS
  const rule = zoneRule(rules, hour?.fhsaa_zone)
  const offline = s.source === 'offline' || meta.link === 'offline'
  const where = weather.location ? `${weather.location.name} · ` : ''
  const coverNote = weather.location ? undefined : s.labels.find((l) => /nearest hours/i.test(l))
  const sourceTitle = hour
    ? `${where}${hour.source === 'fixture' ? 'cached NWS forecast (fixture)' : weatherSourceLabel(hour.source)} · WBGT and FHSAA zone from the HeatTwin engine${coverNote ? ` · ${coverNote}` : ''}`
    : undefined
  return (
    <section className="field glass" aria-label="Field conditions">
      <div className="field__top">
        <span className="eyebrow">WBGT · field</span>
        {offline ? <OfflineBadge /> : <span className="field__src" title={sourceTitle}>{weatherSourceLabel(hour?.source)}</span>}
      </div>
      <div className="field__value display-lg">
        <NumberTicker value={hour?.wbgt_f ?? Number.NaN} decimals={1} suffix="°F" />
      </div>
      <div className="field__zones" role="img" aria-label={`FHSAA zone: ${hour ? hour.fhsaa_zone : '—'}`}>
        {zones.map((z) => (
          <span
            key={z}
            className={`field__zone ${z === hour?.fhsaa_zone ? 'is-on' : ''}`}
            style={{ background: zoneColor(z) }}
          />
        ))}
      </div>
      <div className="field__label" title={rule ? `FHSAA zone ${rule.zone}: ${zoneRuleText(rule)} (${FHSAA_CITATION})` : undefined}>
        <span style={{ color: zoneColor(hour?.fhsaa_zone) }}>●</span>{' '}
        {hour ? `Zone ${hour.fhsaa_zone}${rule ? ` · ${zoneShortText(rule)}` : ''}` : '—'}
      </div>
    </section>
  )
}
