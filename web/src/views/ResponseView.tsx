import { motion, useReducedMotion } from 'motion/react'
import { IconCheck, IconResponse } from '../components/Icons'
import { ease } from '../lib/motion'
import './ResponseView.css'

// Pre-practice readiness: the Zachary Martin Act wants a cold-water tub and an
// emergency plan on site. This page is the checklist, plus the one-tap entry
// into Collapse mode.

const CHECKS = [
  { label: 'Tub filled, ice on hand', detail: 'Probe reads 48.9 °F', ok: true },
  { label: 'Tub within 1 minute of the field', detail: 'East sideline, by the gate', ok: true },
  { label: 'EMS access route clear', detail: 'Gate 3 unlocked · runner assigned', ok: true },
  { label: 'AED on the sideline', detail: 'Checked 3:05 PM', ok: true },
  { label: 'Rectal thermometer', detail: 'None on site — cool 10–15 min before removing', ok: false },
]

const PROTOCOL = ['Call 911', 'Into the tub', 'Stir the water', 'Keep cooling', 'Hand off to EMS']

export function ResponseView({ onStart }: { onStart: () => void }) {
  const reduce = useReducedMotion()
  return (
    <div className="resp">
      <header>
        <div className="eyebrow">Emergency readiness</div>
        <h1 className="display-lg">Cool first, transport second</h1>
      </header>

      <div className="resp__grid">
        <section className="glass resp__start">
          <p className="muted">
            If an athlete collapses or seems confused, start the response. The clock starts immediately and the voice
            walks you through each step.
          </p>
          <button className="resp__big pressable" onClick={onStart}>
            <IconResponse width={28} height={28} />
            Start collapse response
          </button>
          <ol className="resp__protocol">
            {PROTOCOL.map((p, i) => (
              <li key={p}>
                <span className="num">{i + 1}</span>
                {p}
              </li>
            ))}
          </ol>
        </section>

        <section className="glass resp__checks">
          <div className="eyebrow">Before practice</div>
          <ul>
            {CHECKS.map((c, i) => (
              <motion.li
                key={c.label}
                initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
                animate={{ opacity: 1, transform: 'translateY(0px)' }}
                transition={{ duration: 0.28, ease: ease.out, delay: i * 0.04 }}
              >
                <span className={`resp__tick ${c.ok ? 'is-ok' : 'is-warn'}`}>{c.ok ? <IconCheck width={14} height={14} /> : '!'}</span>
                <span>
                  <span className="resp__label">{c.label}</span>
                  <span className="resp__detail faint">{c.detail}</span>
                </span>
              </motion.li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
