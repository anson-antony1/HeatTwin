import { useEffect } from 'react'
import { motion, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react'
import { springValue } from '../lib/motion'
import { useMotionBlur } from '../lib/useMotionBlur'
import './NumberTicker.css'

// Rolling digits. Each column springs to its digit (interruptible — a new
// value mid-roll retargets from wherever the column is), with vertical motion
// blur proportional to roll speed. Reduced motion: values swap in place.

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']

function Digit({ value }: { value: number }) {
  const reduce = useReducedMotion()
  const mv = useSpring(value, springValue.digits)
  useEffect(() => {
    if (reduce) mv.jump(value)
    else mv.set(value)
  }, [value, reduce, mv])
  const transform = useTransform(mv, (v) => `translateY(${-v * 10}%)`)
  const velocity = useVelocity(mv)
  const { ref, filter } = useMotionBlur<HTMLSpanElement>(velocity, 'y', { scale: 0.7, max: 3.5 })

  return (
    <span className="ticker__digit">
      {filter}
      <motion.span ref={ref} className="ticker__col" style={{ transform }}>
        {DIGITS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </motion.span>
    </span>
  )
}

interface Props {
  value: number
  decimals?: number
  className?: string
  suffix?: string
}

export function NumberTicker({ value, decimals = 0, className, suffix }: Props) {
  const text = Number.isFinite(value) ? value.toFixed(decimals) : '—'
  const chars = text.split('')
  return (
    <span className={`ticker num ${className ?? ''}`}>
      <span className="sr-only">
        {text}
        {suffix}
      </span>
      <span className="ticker__glyphs" aria-hidden="true">
        {chars.map((ch, i) => {
          // Key from the right so columns keep identity when the width changes.
          const key = chars.length - i
          return /\d/.test(ch) ? (
            <Digit key={key} value={Number(ch)} />
          ) : (
            <span key={`${key}${ch}`} className="ticker__sep">
              {ch}
            </span>
          )
        })}
        {suffix && <span className="ticker__suffix">{suffix}</span>}
      </span>
    </span>
  )
}
