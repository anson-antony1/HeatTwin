import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { settingsStore, useSettings, type PracticeLocation } from '../data/settingsStore'
import { cToF, msToMph, useWeather, weatherStore } from '../data/weatherStore'
import { zoneColor } from '../data/constants'
import { useEngineMeta } from '../data/engineMeta'
import { zoneRule, zoneRuleText } from '../data/selectors'
import { judgements } from '../data/judgements'
import { usePlanState } from '../data/planStore'
import { NumberTicker } from '../components/NumberTicker'
import { IconCheck, IconReset } from '../components/Icons'
import { AI_NAME } from '../lib/brand'
import { ease } from '../lib/motion'
import './SettingsView.css'

// Settings. Location decides the live weather (NWS through the engine) and the
// site every plan is modeled at. Place search uses Open-Meteo's free geocoder
// straight from the browser (no key); "Use my location" uses the browser's.

const ENGINE = (import.meta.env?.VITE_ENGINE_URL as string | undefined) ?? '/engine'

interface GeoResult {
  id: number
  name: string
  latitude: number
  longitude: number
  admin1?: string
  admin2?: string
  country?: string
  country_code?: string
}

export function SettingsView() {
  const { location } = useSettings()
  const w = useWeather()

  // A GPS fix starts out unnamed; adopt the NWS place name once it arrives.
  useEffect(() => {
    if (location.source === 'gps' && w.place && location.name.startsWith('Current location') && w.location.lat === location.lat) {
      settingsStore.setLocation({ ...location, name: w.place })
    }
  }, [location, w.place, w.location.lat])

  return (
    <div className="settings">
      <header>
        <div className="eyebrow">Settings</div>
        <h1 className="display-lg">Practice location</h1>
      </header>

      <div className="settings__grid">
        <section className="glass settings__card">
          <div className="eyebrow">Where you practice</div>
          <div className="loc">
            <div className="loc__pin" aria-hidden="true" />
            <div className="loc__text">
              <div className="display-sm">{location.name}</div>
              <div className="faint num">
                {location.detail ? `${location.detail} · ` : ''}
                {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
              </div>
            </div>
            {location.source !== 'default' && (
              <button className="btn btn--quiet pressable loc__reset" onClick={() => settingsStore.resetLocation()} title="Back to the demo field">
                <IconReset width={16} height={16} /> Demo field
              </button>
            )}
          </div>

          <LocationSearch />
          <UseMyLocation />

          <p className="settings__note faint">
            Live weather comes from the National Weather Service, so it covers US locations. Anywhere else HeatTwin falls
            back to its demo forecast and says so.
          </p>
        </section>

        <ConditionsCard />
        <SourcesCard />
        <JudgementsCard />
      </div>
    </div>
  )
}

function LocationSearch() {
  const reduce = useReducedMotion()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<GeoResult[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Debounced geocoding.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults([]) // eslint-disable-line react-hooks/set-state-in-effect
      return
    }
    const ctrl = new AbortController()
    const t = window.setTimeout(async () => {
      setBusy(true)
      try {
        const r = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(term)}&count=6&language=en&format=json`,
          { signal: ctrl.signal },
        )
        const d = await r.json()
        setResults((d.results ?? []) as GeoResult[])
        setActive(0)
        setOpen(true)
      } catch {
        /* aborted or offline */
      } finally {
        setBusy(false)
      }
    }, 250)
    return () => {
      ctrl.abort()
      window.clearTimeout(t)
    }
  }, [q])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  const choose = (g: GeoResult) => {
    const detail = [g.admin1, g.country].filter(Boolean).join(', ')
    settingsStore.setLocation({ name: g.name, detail, lat: g.latitude, lon: g.longitude, source: 'search' })
    setQ('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className="search" ref={boxRef}>
      <label className="sr-only" htmlFor="loc-search">
        Search for a town or school
      </label>
      <input
        id="loc-search"
        className="search__input"
        placeholder="Search a town or city — e.g. Tampa, Orlando, Austin"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !results.length) return
          if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1))
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
          else if (e.key === 'Enter') choose(results[active])
          else if (e.key === 'Escape') setOpen(false)
          else return
          e.preventDefault()
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls="loc-results"
        aria-autocomplete="list"
        autoComplete="off"
      />
      {busy && <span className="search__spin spinner" aria-hidden="true" />}
      <AnimatePresence>
        {open && results.length > 0 && (
          <motion.ul
            id="loc-results"
            role="listbox"
            className="search__results"
            // Grows out of the field that opened it.
            style={{ transformOrigin: 'top left' }}
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.97) translateY(-4px)' }}
            animate={{ opacity: 1, transform: 'scale(1) translateY(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: 'scale(0.97) translateY(-4px)', transition: { duration: 0.12 } }}
            transition={{ duration: 0.18, ease: ease.out }}
          >
            {results.map((g, i) => (
              <li
                key={g.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'is-active' : ''}
                onPointerEnter={() => setActive(i)}
                onClick={() => choose(g)}
              >
                <span className="search__name">{g.name}</span>
                <span className="search__detail faint">{[g.admin1, g.country].filter(Boolean).join(', ')}</span>
                {g.country_code !== 'US' && <span className="search__flag">No live NWS</span>}
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

function UseMyLocation() {
  const [state, setState] = useState<'idle' | 'locating' | 'denied'>('idle')
  const go = () => {
    if (!('geolocation' in navigator)) return setState('denied')
    setState('locating')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc: PracticeLocation = {
          name: 'Current location',
          lat: Number(pos.coords.latitude.toFixed(4)),
          lon: Number(pos.coords.longitude.toFixed(4)),
          source: 'gps',
        }
        settingsStore.setLocation(loc)
        setState('idle')
      },
      () => setState('denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    )
  }
  return (
    <div className="gps">
      <button className="btn btn--quiet pressable" onClick={go} disabled={state === 'locating'}>
        {state === 'locating' ? (
          <>
            <span className="spinner spinner--ink" aria-hidden="true" /> Finding you…
          </>
        ) : (
          <>
            <span className="gps__dot" aria-hidden="true" /> Use my current location
          </>
        )}
      </button>
      {state === 'denied' && <span className="faint gps__msg">Location access was blocked — search instead.</span>}
    </div>
  )
}

function ago(ts: number | null) {
  if (!ts) return ''
  const m = Math.round((Date.now() - ts) / 60000)
  return m < 1 ? 'just now' : `${m} min ago`
}

function ConditionsCard() {
  const w = useWeather()
  const reduce = useReducedMotion()
  const now = w.now
  const live = w.source === 'nws_forecast'
  const rules = useEngineMeta().sources?.fhsaa_wbgt_zones?.zones
  const rule = now ? zoneRule(rules, now.fhsaa_zone) : null

  return (
    <section className="glass settings__card conditions" aria-live="polite">
      <div className="conditions__head">
        <div className="eyebrow">Right now · {w.place ?? w.location.name}</div>
        <span className={`src src--${live ? 'live' : 'fixture'}`}>
          <span className="src__dot" aria-hidden="true" />
          {w.status === 'loading' ? 'Loading…' : live ? 'NWS · live' : w.source ? 'Demo forecast' : 'Offline'}
        </span>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={`${w.location.lat},${w.location.lon}`}
          initial={reduce ? { opacity: 0 } : { opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, filter: 'blur(4px)', transition: { duration: 0.12 } }}
          transition={{ duration: 0.28, ease: ease.out }}
        >
          {now ? (
            <>
              <div className="conditions__big">
                <div>
                  <div className="eyebrow">WBGT</div>
                  <div className="display-xl">
                    <NumberTicker value={now.wbgt_f} decimals={1} suffix="°F" />
                  </div>
                </div>
                <div className="conditions__zone" style={{ ['--zone' as string]: zoneColor(now.fhsaa_zone) }}>
                  <span className="conditions__zone-n num">Zone {now.fhsaa_zone}</span>
                  {rule && <span>{zoneRuleText(rule)}</span>}
                </div>
              </div>
              <dl className="conditions__list num">
                <div>
                  <dt>Air</dt>
                  <dd>{Math.round(cToF(now.air_temp_c))}°F</dd>
                </div>
                <div>
                  <dt>Humidity</dt>
                  <dd>{Math.round(now.rh_pct)}%</dd>
                </div>
                <div>
                  <dt>Wind</dt>
                  <dd>{Math.round(msToMph(now.wind_m_s))} mph</dd>
                </div>
                <div>
                  <dt>Cloud</dt>
                  <dd>{Math.round(now.cloud_cover_pct)}%</dd>
                </div>
                {now.nws_wbgt_f != null && (
                  <div>
                    <dt>NWS WBGT</dt>
                    <dd>{now.nws_wbgt_f.toFixed(0)}°F</dd>
                  </div>
                )}
              </dl>
              <div className="hours" aria-label="WBGT, next 12 hours">
                {w.next.map((h, i) => {
                  const t = Number(h.time.slice(11, 13))
                  const pct = Math.max(8, Math.min(100, ((h.wbgt_f - 60) / 35) * 100))
                  return (
                    <div className="hours__col" key={h.time}>
                      <div className="hours__bar-wrap">
                        <motion.span
                          className="hours__bar"
                          style={{ background: zoneColor(h.fhsaa_zone), height: `${pct}%` }}
                          initial={reduce ? false : { transform: 'scaleY(0.2)', opacity: 0 }}
                          animate={{ transform: 'scaleY(1)', opacity: 1 }}
                          transition={{ duration: 0.3, ease: ease.out, delay: i * 0.03 }}
                        />
                      </div>
                      <span className="hours__v num">{Math.round(h.wbgt_f)}</span>
                      <span className="hours__t num">{((t + 11) % 12) + 1}{t >= 12 ? 'p' : 'a'}</span>
                    </div>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="conditions__empty faint">
              {w.status === 'error' ? w.error : 'Fetching conditions…'}
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="conditions__foot faint">
        <span>{w.fetchedAt ? `Updated ${ago(w.fetchedAt)} · refreshes every 10 min` : ''}</span>
        <button className="linkbtn" onClick={() => weatherStore.refresh()}>
          Refresh
        </button>
      </div>
    </section>
  )
}

function SourcesCard() {
  const w = useWeather()
  const p = usePlanState()
  const [engine, setEngine] = useState<'checking' | 'ok' | 'down'>('checking')
  const [llm, setLlm] = useState<{ configured: boolean; model: string } | null>(null)

  useEffect(() => {
    let alive = true
    fetch(`${ENGINE}/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => alive && setEngine(r.ok ? 'ok' : 'down'))
      .catch(() => alive && setEngine('down'))
    fetch(`${ENGINE}/plan/llm_status`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .then((d) => alive && setLlm(d))
      .catch(() => alive && setLlm(null))
    return () => {
      alive = false
    }
  }, [])

  const rows: { label: string; ok: boolean | null; detail: string }[] = [
    { label: 'HeatTwin engine', ok: engine === 'checking' ? null : engine === 'ok', detail: engine === 'down' ? 'Not reachable — start it with make demo (port HEATTWIN_PORT, default 8010)' : 'Two-node model, optimizer' },
    {
      label: 'Weather',
      ok: w.source == null ? null : w.source === 'nws_forecast',
      detail: w.source === 'nws_forecast' ? 'National Weather Service, hourly · WBGT by Liljegren' : 'Demo forecast (NWS unavailable here)',
    },
    {
      label: `${AI_NAME} (voice & text)`,
      ok: llm == null ? null : llm.configured,
      detail: llm ? (llm.configured ? `Google Gemini · ${llm.model}` : 'No GEMINI_API_KEY on the engine') : 'Checking…',
    },
    {
      label: 'Plans modeled at',
      ok: true,
      detail: `${p.plan.site.name} (${p.plan.site.lat.toFixed(2)}, ${p.plan.site.lon.toFixed(2)})`,
    },
  ]

  return (
    <section className="glass settings__card sources">
      <div className="eyebrow">Data sources</div>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <span className={`sources__tick ${r.ok == null ? 'is-wait' : r.ok ? 'is-ok' : 'is-warn'}`}>
              {r.ok ? <IconCheck width={13} height={13} /> : r.ok === false ? '!' : ''}
            </span>
            <span>
              <span className="sources__label">{r.label}</span>
              <span className="sources__detail faint">{r.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}


/** Settings → Sources: the modelling choices that are not measured values (DESIGN, each with its written
 * justification) and anything still TODO — straight from GET /sources (constants.yaml). */
function JudgementsCard() {
  const meta = useEngineMeta()
  const items = judgements(meta.sources)
  const design = items.filter((j) => j.status === 'DESIGN')
  const todo = items.filter((j) => j.status === 'TODO')
  return (
    <section className="glass settings__card sources judgements" aria-label="Judgement calls in the model">
      <div className="eyebrow">Judgement calls (DESIGN) · from constants.yaml</div>
      {!meta.sources ? (
        <p className="faint">Engine sources not loaded.</p>
      ) : (
        <>
          <p className="settings__note faint">
            Choices the model makes where no measurement exists. Each states why; an athletic trainer should review them.
          </p>
          <ul>
            {design.map((j) => (
              <li key={j.path}>
                <span className={`sources__tick ${j.justification ? 'is-ok' : 'is-warn'}`}>{j.justification ? '' : '!'}</span>
                <span>
                  <span className="sources__label">{j.path}</span>
                  <span className="sources__detail faint">{j.justification ?? j.note ?? 'no justification written'}</span>
                </span>
              </li>
            ))}
          </ul>
          {todo.length > 0 && (
            <>
              <div className="eyebrow">Still TODO (not on the demo path)</div>
              <ul>
                {todo.map((j) => (
                  <li key={j.path}>
                    <span className="sources__tick is-warn">!</span>
                    <span>
                      <span className="sources__label">{j.path}</span>
                      <span className="sources__detail faint">{j.note ?? 'needs a source'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  )
}
