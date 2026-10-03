import { useId, useMemo } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { Drill } from '../data/types'
import { THRESHOLDS } from '../data/constants'
import { bandPath, downsample, splinePath, type Pt } from '../lib/spline'
import { HEAT_STOPS, heatColor } from '../lib/heat'
import { ease } from '../lib/motion'
import { useSize } from '../lib/useSize'
import './TempChart.css'

// Core-temperature chart: measured-so-far (solid, heat-coloured), forecast
// (dashed spline), and the p95 band. All curves are Catmull-Rom splines.
// Data lines never move for style — the only flourish is a one-time
// left-to-right reveal on pages people open occasionally (`reveal`).

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
}: Props) {
  const [ref, { width, height }] = useSize<HTMLDivElement>()
  const reduce = useReducedMotion()
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const pad = compact ? { l: 2, r: 6, t: 6, b: 6 } : { l: 44, r: 16, t: 18, b: drills ? 40 : 26 }
  const w = Math.max(0, width - pad.l - pad.r)
  const h = Math.max(0, height - pad.t - pad.b)

  const x = (m: number) => pad.l + (total ? (m / total) * w : 0)
  const y = (c: number) => pad.t + (1 - (c - domain[0]) / (domain[1] - domain[0])) * h

  const paths = useMemo(() => {
    if (!w || !h) return null
    const k = Math.floor(now)
    const target = compact ? 36 : 90
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
  }, [history, forecast, band, now, live, w, h, total, compact, ghost])

  const gradTop = y(HEAT_STOPS[HEAT_STOPS.length - 1][0])
  const gradBottom = y(HEAT_STOPS[0][0])
  const ticks = compact ? [] : [37, 37.5, 38, 38.5, 39, 39.5].filter((t) => t > domain[0] && t < domain[1])
  const timeTicks = compact ? [] : Array.from({ length: Math.floor(total / 15) + 1 }, (_, i) => i * 15)

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

      {/* Alert line */}
      <line
        className="chart__threshold"
        x1={pad.l}
        x2={pad.l + w}
        y1={y(THRESHOLDS.alertC)}
        y2={y(THRESHOLDS.alertC)}
      />
      {!compact && (
        <text className="chart__threshold-label" x={pad.l + w} y={y(THRESHOLDS.alertC) - 7} textAnchor="end">
          {THRESHOLDS.alertC.toFixed(1)}° alert line
        </text>
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

      {/* Now marker + live head */}
      {now > 0 && now < total && (
        <>
          {!compact && <line className="chart__now" x1={x(now)} x2={x(now)} y1={pad.t} y2={pad.t + h} />}
          <circle className="chart__head-glow" cx={x(now)} cy={y(live)} r={compact ? 6 : 10} fill={heatColor(live, 0.28)} />
          <circle cx={x(now)} cy={y(live)} r={compact ? 2.6 : 4} fill={heatColor(live)} stroke="white" strokeWidth={compact ? 1.2 : 2} />
        </>
      )}
    </>
  )

  return (
    <div ref={ref} className={`chart ${compact ? 'chart--compact' : ''}`}>
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
    </div>
  )
}
