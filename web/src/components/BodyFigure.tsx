import { useId } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { heatColor, type HeatScale } from '../lib/heat'
import './BodyFigure.css'

// The athlete's "twin": a stylised figure coloured by the engine's estimated
// core temperature (one colour — nothing models limb temperature).
// Replaces the stock mannequin in the Figma (which carried a watermark).
// The heart marker beats only when there is an HR value (the HR replay);
// athletes without HR get no heartbeat.

// Right half of a front-view figure as cubic segments, from the neck down to
// the crotch; the left half is its mirror. One closed path keeps the outline
// organic (tapered limbs, shoulder caps) instead of stacked primitives.
type Seg = [number, number, number, number, number, number]
const START: [number, number] = [108, 54]
const RIGHT: Seg[] = [
  [109, 72, 112, 78, 122, 82],
  [140, 86, 156, 92, 159, 112],
  [163, 140, 165, 170, 167, 196],
  [169, 222, 172, 246, 174, 266],
  [176, 276, 176, 290, 169, 293],
  [163, 295, 160, 286, 159, 272],
  [156, 250, 152, 228, 150, 206],
  [148, 184, 146, 150, 143, 126],
  [142, 160, 138, 196, 136, 226],
  [135, 240, 141, 252, 141, 272],
  [141, 304, 138, 340, 134, 374],
  [131, 402, 131, 440, 129, 466],
  [130, 476, 138, 484, 136, 491],
  [130, 496, 114, 496, 111, 490],
  [110, 468, 112, 440, 111, 410],
  [110, 380, 107, 330, 101, 298],
  [100.6, 297, 100.2, 296, 100, 296],
]

function buildSilhouette() {
  const m = (x: number) => 200 - x
  let d = `M${START[0]},${START[1]}`
  for (const [a, b, c, e, x, y] of RIGHT) d += `C${a},${b} ${c},${e} ${x},${y}`
  // Walk the mirrored half back up: reverse each segment (swap controls).
  const ends: [number, number][] = [START, ...RIGHT.map((sg) => [sg[4], sg[5]] as [number, number])]
  for (let i = RIGHT.length - 1; i >= 0; i--) {
    const [a, b, c, e] = RIGHT[i]
    const [x0, y0] = ends[i]
    d += `C${m(c)},${e} ${m(a)},${b} ${m(x0)},${y0}`
  }
  return `${d}Z`
}

const SILHOUETTE = buildSilhouette()

export function BodyFigure({ coreC, hr, scale }: { coreC: number; hr: number | null; scale: HeatScale | null }) {
  const reduce = useReducedMotion()
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const beat = hr ? 60 / hr : 0

  return (
    <div className="body">
      <div className="body__aura" style={{ background: `radial-gradient(closest-side, ${heatColor(coreC, scale, 0.42)}, transparent)` }} />
      <svg viewBox="0 0 200 500" className="body__svg" role="img" aria-label={`Thermal figure, estimated core ${coreC.toFixed(1)} °C`}>
        <defs>
          {/* One colour: the core estimate. Nothing models limb or skin temperature, so the figure doesn't pretend to. */}
          <radialGradient id={`thermal-${uid}`} gradientUnits="userSpaceOnUse" cx="100" cy="170" r="300">
            <stop offset="0" stopColor={heatColor(coreC, scale)} />
            <stop offset="0.8" stopColor={heatColor(coreC, scale)} stopOpacity={0.82} />
          </radialGradient>
          <linearGradient id={`sheen-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="white" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="white" stopOpacity="0" />
            <stop offset="1" stopColor="black" stopOpacity="0.08" />
          </linearGradient>
          <g id={`figure-${uid}`}>
            <ellipse cx="100" cy="38" rx="19" ry="24" />
            <path d={SILHOUETTE} />
          </g>
        </defs>

        <use href={`#figure-${uid}`} fill={`url(#thermal-${uid})`} stroke={`url(#thermal-${uid})`} />
        <use href={`#figure-${uid}`} fill={`url(#sheen-${uid})`} stroke={`url(#sheen-${uid})`} />

        {/* Heart: beats at the measured rate. */}
        {hr != null && (
          <g transform="translate(112 128)">
            {!reduce && (
              <motion.circle
                r="9"
                fill="none"
                stroke="white"
                strokeWidth="1.5"
                initial={{ opacity: 0.8, transform: 'scale(0.6)' }}
                animate={{ opacity: 0, transform: 'scale(1.8)' }}
                transition={{ duration: Math.min(0.9, beat * 0.9), repeat: Infinity, repeatDelay: beat * 0.1, ease: [0.23, 1, 0.32, 1] }}
              />
            )}
            <circle r="4" fill="white" />
          </g>
        )}
      </svg>
    </div>
  )
}
