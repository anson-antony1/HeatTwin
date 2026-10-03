import { useEffect, useMemo, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { IconCheck, IconResponse } from '../components/Icons'
import { ease } from '../lib/motion'
import { useCwiTargets } from './collapse/hooks'
import {
  CHECKLIST_IDS,
  checklistItems,
  countChecked,
  getStorage,
  loadChecked,
  localDateKey,
  saveChecked,
  type Checked,
  type ChecklistId,
} from './collapse/checklist'
import { EAP_NOTE } from './collapse/targets'
import './ResponseView.css'

// Pre-practice readiness: the Zachary Martin Act wants a cold-water tub and an
// emergency plan on site. This page is the checklist, plus the one-tap entry
// into Collapse mode. Every item starts unchecked; the user ticks them, and
// HeatTwin cannot verify a tick. Any number shown comes from GET /sources.

const PROTOCOL = ['Call 911', 'Into the tub', 'Stir the water', 'Keep cooling', 'Hand off to EMS']

export function ResponseView({ onStart }: { onStart: () => void }) {
  const reduce = useReducedMotion()
  const targets = useCwiTargets()
  const items = useMemo(() => checklistItems(targets), [targets])
  // Ticks are remembered for the rest of the same calendar day only.
  const today = localDateKey()
  const [checked, setChecked] = useState<Checked>(() => loadChecked(getStorage(), today))

  useEffect(() => {
    saveChecked(getStorage(), today, checked)
  }, [checked, today])

  const toggle = (id: string) =>
    setChecked((c) => (CHECKLIST_IDS.includes(id as ChecklistId) ? { ...c, [id]: !c[id as ChecklistId] } : c))

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
          <p className="resp__note faint" title={targets.ksiSource ?? undefined}>
            Steps follow the KSI Cold Water Immersion Guide. {EAP_NOTE}
          </p>
        </section>

        <section className="glass resp__checks">
          <div className="eyebrow">Before practice</div>
          <ul>
            {items.map((c, i) => {
              const on = checked[c.id as ChecklistId]
              return (
                <motion.li
                  key={c.id}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, transform: 'translateY(6px)' }}
                  animate={{ opacity: 1, transform: 'translateY(0px)' }}
                  transition={{ duration: 0.28, ease: ease.out, delay: i * 0.04 }}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className="resp__row"
                    onClick={() => toggle(c.id)}
                  >
                    <span className={`resp__tick ${on ? 'is-ok' : 'is-off'}`} aria-hidden="true">
                      {on ? <IconCheck width={14} height={14} /> : null}
                    </span>
                    <span>
                      <span className="resp__label">{c.label}</span>
                      <span className="resp__detail faint">{c.detail}</span>
                    </span>
                  </button>
                </motion.li>
              )
            })}
          </ul>
          <p className="resp__count faint">
            {countChecked(checked)} of {items.length} ticked by you. HeatTwin cannot verify these; ticks reset each day.
          </p>
        </section>
      </div>
    </div>
  )
}
