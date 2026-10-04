import { useEffect, useState, type FormEvent } from 'react'
import { searchWeatherLocations, useWeather, weatherStore, type WeatherLocation } from '../data/weather'
import { weatherSourceLabel } from '../data/selectors'
import './SettingsView.css'

export function SettingsView() {
  const weather = useWeather()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<WeatherLocation[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [locating, setLocating] = useState(false)

  useEffect(() => {
    if (query.trim().length < 2) return
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setSearching(true)
      try {
        setMatches(await searchWeatherLocations(query, controller.signal))
        setSearchError(null)
      } catch (error) {
        if ((error as Error).name !== 'AbortError') setSearchError('Location search is unavailable right now.')
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 300)
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [query])

  const choose = (location: WeatherLocation) => {
    setQuery('')
    setMatches([])
    void weatherStore.select(location)
  }

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setSearchError('This browser does not support location access.')
      return
    }
    setLocating(true)
    setSearchError(null)
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setLocating(false)
        choose({ name: 'Current location', latitude: coords.latitude, longitude: coords.longitude })
      },
      (error) => {
        setLocating(false)
        setSearchError(error.code === 1 ? 'Location permission was denied.' : 'Could not determine your current location.')
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    )
  }

  const onSubmit = (event: FormEvent) => event.preventDefault()

  return (
    <div className="settings">
      <header className="settings__head">
        <div className="eyebrow">Coach settings</div>
        <h1 className="display-lg">Settings</h1>
      </header>
      <section className="glass card settings__card" aria-labelledby="weather-settings-title">
        <div className="eyebrow">Field conditions</div>
        <h2 id="weather-settings-title" className="display-sm">Weather location</h2>
        <p className="muted">Choose the practice location for the WBGT forecast shown on the left.</p>
        <div className="settings__current">
          <span className="eyebrow">Selected location</span>
          <strong>{weather.location?.name ?? 'Gainesville demo forecast'}</strong>
          {weather.forecastDate && (
            <span className="muted num" title={weather.forecast?.labels.join(' · ')}>
              Forecast for {weather.forecastDate} · {weatherSourceLabel(weather.forecast?.source)}
            </span>
          )}
        </div>
        <button className="btn btn--ink pressable" onClick={useCurrentLocation} disabled={locating || weather.phase === 'loading'}>
          {locating ? 'Finding location…' : 'Use current location'}
        </button>
        <form className="settings__search" onSubmit={onSubmit}>
          <label htmlFor="weather-city">Or search for a US city</label>
          <input id="weather-city" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="City or ZIP code" autoComplete="off" />
          {searching && <span className="muted">Searching…</span>}
          {matches.length > 0 && (
            <ul className="settings__matches">
              {matches.map((location) => (
                <li key={`${location.latitude},${location.longitude}`}>
                  <button type="button" onClick={() => choose(location)}>{location.name}</button>
                </li>
              ))}
            </ul>
          )}
        </form>
        {weather.phase === 'loading' && <p className="muted" role="status">Loading NWS WBGT forecast…</p>}
        {(searchError || weather.error) && <p className="settings__error" role="alert">{searchError ?? weather.error}</p>}
        <p className="settings__source faint">WBGT forecast: NWS, through the HeatTwin engine. Location search: Open-Meteo.</p>
      </section>
    </div>
  )
}
