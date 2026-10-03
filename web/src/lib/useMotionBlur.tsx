import { useId, useRef } from 'react'
import { useMotionValueEvent, useReducedMotion, type MotionValue } from 'motion/react'

// Directional motion blur driven by a motion value's velocity. Blur is applied
// along the axis of travel only, scales with speed, and is removed entirely at
// rest so idle elements pay nothing. Use on small, fast-moving elements only
// (digits, indicators) — SVG filters on large surfaces are expensive.

interface Options {
  /** px of blur per unit of velocity. */
  scale?: number
  /** Cap in px. Keep well under 20 (Safari cost). */
  max?: number
}

export function useMotionBlur<T extends HTMLElement | SVGElement>(
  velocity: MotionValue<number>,
  axis: 'x' | 'y',
  { scale = 0.01, max = 6 }: Options = {},
) {
  const reduce = useReducedMotion()
  const id = `mb-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`
  const blurRef = useRef<SVGFEGaussianBlurElement>(null)
  const ref = useRef<T>(null)
  const on = useRef(false)

  useMotionValueEvent(velocity, 'change', (v) => {
    const el = ref.current
    const blur = blurRef.current
    if (!el || !blur || reduce) return
    const amount = Math.min(max, Math.abs(v) * scale)
    blur.setAttribute('stdDeviation', axis === 'x' ? `${amount.toFixed(2)} 0` : `0 ${amount.toFixed(2)}`)
    const next = amount > 0.2
    if (next !== on.current) {
      on.current = next
      el.style.filter = next ? `url(#${id})` : ''
    }
  })

  const filter = (
    <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
      <filter id={id} x="-30%" y="-60%" width="160%" height="220%" colorInterpolationFilters="sRGB">
        <feGaussianBlur ref={blurRef} stdDeviation="0 0" />
      </filter>
    </svg>
  )

  return { ref, filter }
}
