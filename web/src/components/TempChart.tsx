import { useId, useMemo, useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Drill } from '../data/types'
import { THRESHOLDS } from '../data/constants'
import { bandPath, downsample, splinePath, type Pt } from '../lib/spline'
import { clockLabel, HEAT_STOPS, heatColor } from '../lib/heat'
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
  drills?: Drill[]
  domain?: [number, number]
  /** Optional comparison series (e.g. original plan) drawn faint. */
  ghost?: number[]
  /** Visible window in practice minutes (zoom). Defaults to the whole session. */
  view?: [number, number]
  startHour?: number
  scrub?: number | null
  onScrub?: (minute: number | null) => void
  onSeek?: (minute: number) => void
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
  domain = [36.8, 39.6],
  ghost,
  view,
  startHour,
  scrub = null,
  onScrub,
  onSeek,
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
  const dataTop = Math.max(domain[1], THRESHOLDS.alertC, live,
    ...history.filter(Number.isFinite), ...forecast.map((value, i) => value + (band[i] ?? 0)).filter(Number.isFinite),
    ...(ghost ?? []).filter(Number.isFinite))
  const dataBottom = Math.min(domain[0], live, ...history.filter(Number.isFinite),
    ...forecast.map((value, i) => value - (band[i] ?? 0)).filter(Number.isFinite))
  const floor = Math.min(domain[0], Math.floor((dataBottom - 0.15) * 2) / 2)
  const ceiling = Math.max(domain[1], Math.ceil((dataTop + 0.15) * 2) / 2)
  const y = (c: number) => pad.t + (1 - (c - floor) / (ceiling - floor)) * h

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
  }, [history, forecast, band, now, live, w, h, total, compact, ghost, v0, v1, floor, ceiling])

  const gradTop = y(HEAT_STOPS[HEAT_STOPS.length - 1][0])
  const gradBottom = y(HEAT_STOPS[0][0])
  const ticks = compact ? [] : Array.from({ length: Math.ceil((ceiling - floor) * 2) + 1 }, (_, i) => floor + i * 0.5).filter((t) => t > floor && t < ceiling)
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
    if (e.key === 'Escape') onScrub(null)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const target = Math.max(0, Math.min(total, from + (e.key === 'ArrowRight' ? step : -step)))
      if (onSeek) {
        onSeek(target)
        onScrub(null)
      } else onScrub(target)
    } else return
    e.preventDefault()
  }

  const scrubRead = scrub != null ? read(scrub) : null
  const drillAtScrub = (() => {
    if (scrub == null || !drills) return null
    let t = 0
    for (const d of drills) {
      if (scrub < t + d.minutes) return d
      t += d.minutes
    }
    return drills[drills.length - 1] ?? null
  })()

  const body = paths && (
    <>
      <defs>
        <linearGradient id={`heat-${uid}`} gradientUnits="userSpaceOnUse" x1="0" y1={gradBottom} x2="0" y2={gradTop}>
          {HEAT_STOPS.map(([c]) => (
            <stop
              key={c}
              offset={(c - HEAT_STOPS[0][0]) / (HEAT_STOPS[HEAT_STOPS.length - 1][0] - HEAT_STOPS[0][0])}
              stopColor={heatColor(c)}
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
          <rect x={pad.l} y={pad.t} width={w} height={h} />
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

      {/* Drill underlay */}
      {drills && (
        <g>
          {(() => {
            let t = 0
            return drills.map((d) => {
              const x0 = x(t)
              t += d.minutes
              const x1 = x(t)
              return (
                <rect
                  key={d.id}
                  className={`chart__drill chart__drill--${d.kind}`}
                  x={x0 + 0.5}
                  y={pad.t + h + 26}
                  width={Math.max(0, x1 - x0 - 1)}
                  height={6}
                  rx={3}
                >
                  <title>{`${d.name} · ${d.minutes} min`}</title>
                </rect>
              )
            })
          })()}
        </g>
      )}

      <g clipPath={`url(#plot-${uid})`}>

      {/* Alert line */}
      <line
        className="chart__threshold"
        x1={pad.l}
        x2={pad.l + w}
        y1={y(THRESHOLDS.alertC)}
        y2={y(THRESHOLDS.alertC)}
      />

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
      {!compact && (
        <text className="chart__threshold-label" x={pad.l + w} y={y(THRESHOLDS.alertC) - 7} textAnchor="end">
          {THRESHOLDS.alertC.toFixed(1)}° alert line
        </text>
      )}

      {/* Now marker + live head */}
      {now > 0 && now < total && now >= v0 && now <= v1 && (
        <>
          {!compact && <line className="chart__now" x1={x(now)} x2={x(now)} y1={pad.t} y2={pad.t + h} />}
          <circle className="chart__head-glow" cx={x(now)} cy={y(live)} r={compact ? 6 : 10} fill={heatColor(live, 0.28)} />
          <circle cx={x(now)} cy={y(live)} r={compact ? 2.6 : 4} fill={heatColor(live)} stroke="white" strokeWidth={compact ? 1.2 : 2} />
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
          <circle cx={x(scrub)} cy={y(scrubRead.c)} r={5.5} fill={heatColor(scrubRead.c)} stroke="white" strokeWidth={2.5} />
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
            onSeek?.(minuteAt(e.clientX - r.left))
          }}
          onPointerMove={(e) => {
            handleMove(e)
            if (pressed.current) {
              const r = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
              onSeek?.(minuteAt(e.clientX - r.left))
            }
          }}
          onPointerUp={() => {
            pressed.current = false
            onScrub(null)
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
          <div className="chart__tip-temp num" style={{ color: heatColor(scrubRead.c) }}>
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
