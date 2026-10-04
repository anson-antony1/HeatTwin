import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Status } from '../data/types'
import { ease } from '../lib/motion'
import './StatusPill.css'

// Tone of the engine's status: below_limit → steady, near_limit → watch, over_limit → alert ("none": no estimate).
const LABEL: Record<Status, string> = {
  steady: 'Steady',
  watch: 'Watch',
  alert: 'Over line',
  none: '—',
}

// State change is the point here, so the label rolls (up when worsening,
// blurred mid-swap so the two words read as one transformation).
export function StatusPill({ status, size = 'md' }: { status: Status; size?: 'sm' | 'md' }) {
  const reduce = useReducedMotion()
  const move = reduce ? '0%' : '60%'
  return (
    <span className={`pill pill--${status} pill--${size}`}>
      <span className="pill__dot" aria-hidden="true" />
      <span className="pill__label">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={status}
            initial={{ opacity: 0, filter: 'blur(3px)', transform: `translateY(${move})` }}
            animate={{ opacity: 1, filter: 'blur(0px)', transform: 'translateY(0%)' }}
            exit={{ opacity: 0, filter: 'blur(3px)', transform: `translateY(-${move})` }}
            transition={{ duration: 0.24, ease: ease.out }}
          >
            {LABEL[status]}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}
