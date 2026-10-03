import { useRef, useState, type ReactNode } from 'react'
import './HoldButton.css'

// Hold-to-confirm for actions that must not fire by accident. The fill is
// slow and linear while held (it's a progress indicator — the user is
// deciding) and snaps back fast on release (the system responding).
export function HoldButton({
  children,
  onConfirm,
  tone = 'ink',
  holdMs = 1400,
  hint = 'Hold to confirm',
}: {
  children: ReactNode
  onConfirm: () => void
  tone?: 'ink' | 'alert'
  holdMs?: number
  hint?: string
}) {
  const [holding, setHolding] = useState(false)
  const fired = useRef(false)

  const start = () => {
    fired.current = false
    setHolding(true)
  }
  const stop = () => setHolding(false)

  return (
    <button
      className={`hold hold--${tone} ${holding ? 'is-holding' : ''}`}
      style={{ ['--hold' as string]: `${holdMs}ms` }}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start()
      }}
      onKeyUp={stop}
      aria-description={hint}
    >
      <span className="hold__label">{children}</span>
      <span
        className="hold__overlay"
        aria-hidden="true"
        onTransitionEnd={(e) => {
          if (e.propertyName === 'clip-path' && holding && !fired.current) {
            fired.current = true
            setHolding(false)
            onConfirm()
          }
        }}
      >
        <span className="hold__label">{children}</span>
      </span>
    </button>
  )
}
