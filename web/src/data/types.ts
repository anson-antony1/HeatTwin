// Data shapes the UI codes against. These mirror what the engine
// (engine/api.py) is expected to return — when CONTRACTS.md lands, align
// field names here and the rest of the app follows.

export type Position = 'OL' | 'DL' | 'LB' | 'TE' | 'RB' | 'QB' | 'WR' | 'DB' | 'K' | string

export type Gear = 'none' | 'helmet' | 'shells' | 'full'

export type DrillKind = 'warmup' | 'individual' | 'team' | 'conditioning' | 'break'

export interface Athlete {
  id: string
  name: string
  number: number
  position: Position
  massKg: number
  heightCm: number
  /** Days practiced in the heat this preseason (FHSAA acclimatization period is 14). */
  acclimDay: number
  hrRest: number
  hrMax: number
  /** Has a paired HR strap / watch broadcasting the standard Heart Rate Service. */
  hasStrap: boolean
}

export interface Drill {
  id: string
  name: string
  kind: DrillKind
  minutes: number
  /** Metabolic intensity in PHS met units (1 met = 58.2 W/m²). */
  met: number
  gear: Gear
}

export interface WeatherHour {
  /** Local hour, 24h. */
  hour: number
  tempF: number
  rh: number
  windMph: number
  wbgtF: number
  source: 'forecast' | 'nws_forecast' | 'field-node'
}

export type ZoneId = 'green' | 'yellow' | 'orange' | 'red' | 'black'

export interface Zone {
  id: ZoneId
  label: string
  minWbgtF: number
  maxPracticeMin: number | null
  breaksPerHour: number
  gearRule: string
}

export type Status = 'steady' | 'watch' | 'alert'

/** One athlete's state at the current practice minute. */
export interface AthleteLive {
  id: string
  /** Estimated core temperature, °C. Planning / early-warning only. */
  coreC: number
  hr: number | null
  /** Measured-so-far estimate, one sample per practice minute. */
  history: number[]
  /** Forecast for the full session, one sample per minute (re-forecast live). */
  forecast: number[]
  /** p95 half-width of the forecast band, °C, per minute. */
  band: number[]
  predictedPeakC: number
  predictedPeakMin: number
  status: Status
  /** Minutes the estimate has stayed above the alert line (persistence gate). */
  minutesOverLine: number
}

export interface SessionState {
  /** Increments on every reset / plan change, so UI state can key off a run. */
  session: number
  /** Fractional practice minute since start. */
  minute: number
  totalMinutes: number
  startHour: number
  drillIndex: number
  drillMinuteLeft: number
  nextBreakIn: number | null
  wbgtF: number
  zone: Zone
  athletes: Record<string, AthleteLive>
  running: boolean
  speed: number
  /** 'engine' when forecasts come from a confirmed plan's /simulate result. */
  forecastSource: 'engine' | 'replay'
}
