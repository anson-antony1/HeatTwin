import { useEffect, type ComponentType, type SVGProps } from 'react'
import { motion, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react'
import { useMotionBlur } from '../lib/useMotionBlur'
import { IconAthlete, IconLive, IconPlan, IconResponse, IconSettings } from './Icons'
import { FieldCard } from './FieldCard'
import './Sidebar.css'

export type View = 'live' | 'plan' | 'athlete' | 'response' | 'settings'

const ITEMS: { id: View; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>> }[] = [
  { id: 'live', label: 'Live roster', Icon: IconLive },
  { id: 'plan', label: 'Practice plan', Icon: IconPlan },
  { id: 'athlete', label: 'Athlete twin', Icon: IconAthlete },
  { id: 'response', label: 'Response', Icon: IconResponse },
  { id: 'settings', label: 'Settings', Icon: IconSettings },
]

const ROW = 52 // item height + gap, px

interface Props {
  view: View
  onNavigate: (v: View) => void
  alertCount: number
}

export function Sidebar({ view, onNavigate, alertCount }: Props) {
  const index = Math.max(0, ITEMS.findIndex((i) => i.id === view))
  const reduce = useReducedMotion()
  // The indicator is a single element that travels between items — spatial
  // continuity — on a critically-damped spring so a rapid second click
  // retargets mid-flight. Vertical motion blur scales with its speed.
  const y = useSpring(index * ROW, { bounce: 0, visualDuration: 0.32 })
  useEffect(() => {
    if (reduce) y.jump(index * ROW)
    else y.set(index * ROW)
  }, [index, reduce, y])
  const transform = useTransform(y, (v) => `translateY(${v}px)`)
  const velocity = useVelocity(y)
  const { ref, filter } = useMotionBlur<HTMLDivElement>(velocity, 'y', { scale: 0.006, max: 5 })

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden="true" />
        <span className="display-md">HeatTwin</span>
      </div>

      <nav className="sidebar__nav glass" aria-label="Primary">
        <div className="sidebar__list">
          {filter}
          <motion.div ref={ref} className="sidebar__indicator" style={{ transform }} aria-hidden="true" />
          {ITEMS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`sidebar__item pressable ${id === view ? 'is-active' : ''}`}
              aria-current={id === view ? 'page' : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon />
              <span>{label}</span>
              {id === 'live' && alertCount > 0 && (
                <span className="sidebar__badge num" aria-label={`${alertCount} alerts`}>
                  {alertCount}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="sidebar__foot">
          <div className="eyebrow">Signed in</div>
          <div className="sidebar__coach">
            <span className="sidebar__avatar" aria-hidden="true">
              CR
            </span>
            <div>
              <div className="sidebar__coach-name">Coach Reyes</div>
              <div className="faint" style={{ fontSize: 12.5 }}>
                Head coach · no AT on site · demo persona
              </div>
            </div>
          </div>
        </div>
      </nav>

      <FieldCard />
    </aside>
  )
}
