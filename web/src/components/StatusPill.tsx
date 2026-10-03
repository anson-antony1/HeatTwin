import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AthleteStatus } from '../data/engineApi'
import { STATUS_LABEL, statusTone } from '../data/selectors'
import { ease } from '../lib/motion'
import './StatusPill.css'

// The engine's status for an athlete (below_limit / near_limit / over_limit,
// judged on p95 against the AT-owned planning line). Never "safe".
// State change is the point here, so the label rolls (up when worsening,
// blurred mid-swap so the two words read as one transformation).
export function StatusPill({ status, size = 'md' }: { status: AthleteStatus; size?: 'sm' | 'md' }) {
  const reduce = useReducedMotion()
  const move = reduce ? '0%' : '60%'
  return (
    <span className={`pill pill--${statusTone(status)} pill--${size}`}>
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
            {STATUS_LABEL[status]}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}
