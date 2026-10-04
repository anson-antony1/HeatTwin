import { motion, useReducedMotion } from 'motion/react'
import { IconCheck, IconResponse } from '../components/Icons'
import { useEngineMeta } from '../data/engineMeta'
import { cwiTargets, fmtRange, tubLimitF, tubReadingF } from '../data/cwi'
import { ease } from '../lib/motion'
import './ResponseView.css'

// Pre-practice readiness: the Zachary Martin Act wants a cold-water tub and an
// emergency plan on site. This page is the checklist, plus the one-tap entry
// into Collapse mode. Numbers come from the engine (GET /sources: KSI; GET
// /node/latest: the tub probe). HeatTwin can only tick what it can read: the
// tub probe. Everything else is the coach's to check (shown with "!").

const PROTOCOL = ['Call 911', 'Into the tub', 'Stir the water', 'Keep cooling', 'Hand off to EMS']

export function ResponseView({ onStart }: { onStart: () => void }) {
  const reduce = useReducedMotion()
  const meta = useEngineMeta()
  const t = cwiTargets(meta.sources)
  const tubF = tubReadingF(meta.node)
  const limitF = tubLimitF(t)
  const CHECKS = [
    {
      label: 'Tub filled, ice on hand',
      detail: tubF != null ? `Probe reads ${tubF.toFixed(1)} °F` : 'Probe reads — (no tub probe reading)',
      ok: tubF != null && limitF != null && tubF < limitF,
    },
    {
      label: `Tub within ${fmtRange(t.tubWithinMin)} minutes of the field`,
      detail: 'KSI Cold Water Immersion Guide · check on site',
      ok: false,
    },
    { label: 'EMS access route clear', detail: 'Per your emergency action plan · check on site', ok: false },
    { label: 'AED on the sideline', detail: 'Per your emergency action plan · check on site', ok: false },
    {
      label: 'Rectal thermometer',
      detail: `None on site — cool ${fmtRange(t.noRectalCoolMin)} min before removing`,
      ok: false,
    },
  ]
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
