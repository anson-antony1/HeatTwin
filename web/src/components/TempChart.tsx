import { useId, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { ContractDrill } from '../data/llmPlan'
import { bandPath, downsample, splinePath, type Pt } from '../lib/spline'
import { chartDomain, clockLabel, heatColor, heatStops, niceTicks, type HeatScale } from '../lib/heat'
import { ease } from '../lib/motion'
import { useSize } from '../lib/useSize'
import './TempChart.css'

// Core-temperature chart: measured-so-far (solid, heat-coloured), forecast
// (dashed spline), and the p95 band. All curves are Catmull-Rom splines.
// Data lines never move for style — the only flourish is a one-time
// left-to-right reveal on pages people open occasionally (`reveal`).
//
// Scrubbing (`onScrub`): hover or drag across the plot to read any minute —
// the cursor tracks the pointer 1:1, no easing (direct manipulation). Arrow
// keys step a minute (Shift: 5). `view` zooms to a window of minutes.

interface Props {
  history: number[]
  forecast: number[]
  band: number[]
  total: number
  now: number
  live: number
  compact?: boolean
  reveal?: boolean
  drills?: ContractDrill[]
  /** Planning line (the result's `limit_core_c`, AT-owned); null hides it. */
  limit: number | null
  /** Start of the near band (limit − GET /settings near_limit_margin_c); null hides it. */
  near?: number | null
  /** Colour boundaries from the engine (lib/useHeatScale). */
  scale: HeatScale | null
  domain?: [number, number]
  /** Optional comparison series (e.g. original plan) drawn faint. */
  ghost?: number[]
  /** Visible window in practice minutes (zoom). Defaults to the whole session. */
  view?: [number, number]
  startHour?: number
  scrub?: number | null
  onScrub?: (minute: number | null) => void
}

export function TempChart({
  history,
  forecast,
  band,
  total,
  now,
  live,
  compact = false,
  reveal = false,
  drills,
  limit,
  near = null,
  scale,
  domain: domainProp,
  ghost,
  view,
  startHour,
  scrub = null,
  onScrub,
}: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>()
  const reduce = useReducedMotion()
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const pad = compact ? { l: 2, r: 6, t: 6, b: 6 } : { l: 44, r: 16, t: 18, b: drills ? 40 : 26 }
  const w = Math.max(0, width - pad.l - pad.r)
  const h = Math.max(0, height - pad.t - pad.b)

  const v0 = view?.[0] ?? 0
  const v1 = view?.[1] ?? total
  const span = Math.max(1, v1 - v0)
  const x = (m: number) => pad.l + ((m - v0) / span) * w
  const minuteAt = (px: number) => Math.max(0, Math.min(total, Math.round(v0 + ((px - pad.l) / (w || 1)) * span)))
  const pressed = useRef(false)
  // y-range from the data and the planning line unless the caller shares one across rows.
  const domain = useMemo(
    () => domainProp ?? chartDomain([...history, ...forecast.map((v, i) => v + (band[i] ?? 0)), ...forecast.map((v, i) => v - (band[i] ?? 0))], [limit, near]),
    [domainProp, history, forecast, band, limit, near],
  )
  const y = (c: number) => pad.t + (1 - (c - domain[0]) / (domain[1] - domain[0])) * h

  const paths = useMemo(() => {
    if (!w || !h) return null
    const k = Math.floor(now)
    // More samples when zoomed, so the curve keeps its detail.
    const target = compact ? 36 : Math.min(400, Math.round((90 * (total || 1)) / span))
    const histPts: Pt[] = downsample(history, target).map(({ value, index }) => [x(index), y(value)])
    if (now > k) histPts.push([x(now), y(live)])

    const fut = forecast.slice(k)
    const futSampled = downsample(fut, Math.max(2, Math.round((target * fut.length) / (total || 1))))
    const futPts: Pt[] = futSampled.map(({ value, index }) => [x(k + index), y(value)])
    const up: Pt[] = futSampled.map(({ value, index }) => [x(k + index), y(value + (band[k + index] ?? 0))])
    const lo: Pt[] = futSampled.map(({ value, index }) => [x(k + index), y(value - (band[k + index] ?? 0))])

    const ghostPts: Pt[] | null = ghost
      ? downsample(ghost, target).map(({ value, index }) => [x(index), y(value)])
      : null

    // Area under the measured line, for a soft heat wash.
    const histLine = splinePath(histPts)
    const area = histPts.length > 1
      ? `${histLine}L${histPts[histPts.length - 1][0]},${pad.t + h}L${histPts[0][0]},${pad.t + h}Z`
      : ''

    return {
      hist: histLine,
      area,
      fut: futPts.length > 1 ? splinePath(futPts) : '',
      band: up.length > 1 ? bandPath(up, lo) : '',
      ghost: ghostPts ? splinePath(ghostPts) : '',
    }
    // x/y are pure functions of the inputs listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, forecast, band, now, live, w, h, total, compact, ghost, v0, v1, domain])

  const stops = scale ? heatStops(scale) : null
  const gradTop = stops ? y(stops[stops.length - 1][0]) : 0
  const gradBottom = stops ? y(stops[0][0]) : 1
  const ticks = compact ? [] : niceTicks(domain).filter((t) => t > domain[0] && t < domain[1])
  const tickStep = span <= 32 ? 5 : span <= 64 ? 10 : 15
  const timeTicks = compact
    ? []
    : Array.from({ length: Math.floor(total / tickStep) + 1 }, (_, i) => i * tickStep).filter((m) => m >= v0 - 0.01 && m <= v1 + 0.01)

  // What the chart reads at the scrubbed minute.
  const read = (m: number) => {
    const k = Math.floor(now)
    if (m <= k) return { c: history[m] ?? live, band: 0, measured: true }
    if (m <= now) return { c: live, band: 0, measured: true }
    return { c: forecast[m] ?? forecast[forecast.length - 1], band: band[m] ?? 0, measured: false }
  }

  const handleMove = (e: PointerEvent<SVGRectElement>) => {
    if (!onScrub) return
    if (e.pointerType !== 'mouse' && !pressed.current) return
    const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
    onScrub(minuteAt(e.clientX - r.left))
  }
  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onScrub) return
    const step = e.shiftKey ? 5 : 1
    const from = scrub ?? Math.round(now)
    if (e.key === 'ArrowRight') onScrub(Math.min(total, from + step))
    else if (e.key === 'ArrowLeft') onScrub(Math.max(0, from - step))
    else if (e.key === 'Escape') onScrub(null)
    else return
    e.preventDefault()
  }

  const scrubRead = scrub != null ? read(scrub) : null
  const drillAtScrub = (() => {
    if (scrub == null || !drills) return null
    let t = 0
    for (const d of drills) {
      if (scrub < t + d.duration_min) return d
      t += d.duration_min
    }
    return drills[drills.length - 1] ?? null
  })()

  const body = paths && (
    <>
      <defs>
        <linearGradient id={`heat-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={gradBottom} x2="0" y2={gradTop}>
          {stops?.map(([c], i) => (
            <stop
              key={i}
              offset={(c - stops[0][0]) / (stops[stops.length - 1][0] - stops[0][0] || 1)}
              stopColor={heatColor(c, scale)}
            />
          ))}
        </linearGradient>
        <linearGradient id={`wash-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="white" stopOpacity="0.55" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <mask id={`wash-mask-${uid}`}>
          <path d={paths.area} fill={`url(#wash-${uid})`} />
        </mask>
        <clipPath id={`plot-${uid}`}>
          <rect x={pad.l - 12} y={0} width={w + 24} height={height} />
        </clipPath>
      </defs>

      {/* Grid */}
      {ticks.map((t) => (
        <g key={t}>
          <line className="chart__grid" x1={pad.l} x2={pad.l + w} y1={y(t)} y2={y(t)} />
          <text className="chart__tick" x={pad.l - 10} y={y(t)} dy="0.32em" textAnchor="end">
            {t.toFixed(1)}°
          </text>
        </g>
      ))}
      {timeTicks.map((m) => (
        <text key={m} className="chart__tick" x={x(m)} y={pad.t + h + 18} textAnchor="middle">
          {m}′
        </text>
      ))}

      <g clipPath={view ? `url(#plot-${uid})` : undefined}>
      {/* Drill underlay */}
      {drills && (
        <g>
          {(() => {
            let t = 0
            return drills.map((d) => {
              const x0 = x(t)
              t += d.duration_min
              const x1 = x(t)
              return (
                <rect
                  key={d.id}
                  className={`chart__drill chart__drill--${drillTone(d)}`}
                  x={x0 + 0.5}
                  y={pad.t + h + 26}
                  width={Math.max(0, x1 - x0 - 1)}
                  height={6}
                  rx={3}
                >
                  <title>{`${d.name} · ${d.duration_min} min`}</title>
                </rect>
              )
            })
          })()}
        </g>
      )}

      {/* Planning line (result limit_core_c) and near band (GET /settings) — AT-owned illustrative defaults */}
      {near != null && limit != null && near < limit && (
        <>
          <line className="chart__near" x1={pad.l} x2={pad.l + w} y1={y(near)} y2={y(near)} />
          {!compact && (
            <text className="chart__near-label" x={pad.l + w} y={y(near) + 13} textAnchor="end">
              near band from {near.toFixed(1)}°
            </text>
          )}
        </>
      )}
      {limit != null && (
        <>
          <line className="chart__threshold" x1={pad.l} x2={pad.l + w} y1={y(limit)} y2={y(limit)} />
          {!compact && (
            <text className="chart__threshold-label" x={pad.l + w} y={y(limit) - 7} textAnchor="end">
              {limit.toFixed(1)}° planning line (AT-owned default)
            </text>
          )}
        </>
      )}

      {paths.ghost && <path className="chart__ghost" d={paths.ghost} />}
      {paths.band && <path className="chart__band" d={paths.band} />}
      <rect
        x={pad.l}
        y={pad.t}
        width={w}
        height={h}
        fill={`url(#heat-${uid})`}
        mask={`url(#wash-mask-${uid})`}
        opacity={0.5}
      />
      {paths.fut && <path className="chart__forecast" d={paths.fut} stroke={`url(#heat-${uid})`} />}
      <path className="chart__history" d={paths.hist} stroke={`url(#heat-${uid})`} />

      </g>

      {/* Now marker + live head */}
      {now > 0 && now < total && now >= v0 && now <= v1 && (
        <>
          {!compact && <line className="chart__now" x1={x(now)} x2={x(now)} y1={pad.t} y2={pad.t + h} />}
          <circle className="chart__head-glow" cx={x(now)} cy={y(live)} r={compact ? 6 : 10} fill={heatColor(live, scale, 0.28)} />
          <circle cx={x(now)} cy={y(live)} r={compact ? 2.6 : 4} fill={heatColor(live, scale)} stroke="white" strokeWidth={compact ? 1.2 : 2} />
        </>
      )}

      {scrubRead && scrub != null && (
        <g className="chart__scrub" pointerEvents="none">
          <line x1={x(scrub)} x2={x(scrub)} y1={pad.t - 6} y2={pad.t + h} />
          {scrubRead.band > 0 && (
            <line
              className="chart__scrub-band"
              x1={x(scrub)}
              x2={x(scrub)}
              y1={y(scrubRead.c + scrubRead.band)}
              y2={y(scrubRead.c - scrubRead.band)}
            />
          )}
          <circle cx={x(scrub)} cy={y(scrubRead.c)} r={5.5} fill={heatColor(scrubRead.c, scale)} stroke="white" strokeWidth={2.5} />
        </g>
      )}

      {onScrub && (
        <rect
          className="chart__hit"
          x={pad.l}
          y={0}
          width={w}
          height={pad.t + h}
          onPointerDown={(e) => {
            pressed.current = true
            e.currentTarget.setPointerCapture(e.pointerId)
            const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
            onScrub(minuteAt(e.clientX - r.left))
          }}
          onPointerMove={handleMove}
          onPointerUp={() => {
            pressed.current = false
          }}
          onPointerCancel={() => {
            pressed.current = false
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse' && !pressed.current) onScrub(null)
          }}
        />
      )}
    </>
  )

  return (
    <div
      ref={ref}
      className={`chart ${compact ? 'chart--compact' : ''} ${onScrub ? 'chart--scrub' : ''}`}
      tabIndex={onScrub ? 0 : undefined}
      onKeyDown={handleKey}
      aria-label={onScrub ? 'Core temperature chart. Use arrow keys to scrub through practice.' : undefined}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Estimated core temperature ${live.toFixed(1)} degrees Celsius`}>
          {reveal && !reduce ? (
            <motion.g
              initial={{ clipPath: 'inset(0 100% 0 0)' }}
              animate={{ clipPath: 'inset(0 0% 0 0)' }}
              transition={{ duration: 0.9, ease: ease.inOut }}
            >
              {body}
            </motion.g>
          ) : (
            body
          )}
        </svg>
      )}
      {scrubRead && scrub != null && w > 0 && (
        <div
          className={`chart__tip ${x(scrub) > pad.l + w * 0.62 ? 'is-left' : ''}`}
          style={{ transform: `translate(${x(scrub)}px, ${pad.t}px)` }}
          role="status"
        >
          <div className="chart__tip-time num">
            {startHour != null ? clockLabel(startHour, scrub) : ''} · {scrub}′
          </div>
          <div className="chart__tip-temp num" style={{ color: heatColor(scrubRead.c, scale) }}>
            {scrubRead.c.toFixed(2)}°C
            {scrubRead.band > 0 && <span className="chart__tip-band"> ±{scrubRead.band.toFixed(2)}</span>}
          </div>
          <div className="chart__tip-meta">
            {scrubRead.measured ? 'Estimate so far' : 'Forecast'}
            {drillAtScrub ? ` · ${drillAtScrub.name}` : ''}
          </div>
        </div>
      )}
    </div>
  )
}

/** CSS tone for a plan block on the chart's drill underlay (display only). */
function drillTone(d: ContractDrill): string {
  if (d.is_break) return 'break'
  if (d.intensity === 'max') return 'conditioning'
  if (d.intensity === 'hard') return 'team'
  return 'individual'
}
