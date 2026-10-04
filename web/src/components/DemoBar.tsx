import { motion } from 'motion/react'
import { engine, useSession } from '../data/engine'
import { clockLabel } from '../lib/heat'
import { spring } from '../lib/motion'
import { useReplayScrub } from '../lib/useReplayScrub'
import { IconPause, IconPlay, IconReset, IconSkip } from './Icons'
import './DemoBar.css'

const SPEEDS = [1, 4, 10]

// Demo transport. Practice minutes run `speed`× per real second so a
// two-hour session plays in two minutes on stage. Labelled as a replay so
// nobody mistakes it for a live feed.
export function DemoBar() {
  const s = useSession()
  const progress = s.totalMinutes > 0 ? s.minute / s.totalMinutes : 0
  // "Skip to heat": the earliest minute the engine forecasts anyone over the line (else its first gates flag).
  const skipTo = s.skipTo
  // 'Live' only for a strap stream; hr_bridge replaying a file on the live clock is still a replay.
  const tag = s.source === 'offline' ? 'Offline' : s.clock === 'live' && !/^replay/i.test(s.live.label ?? '') ? 'Live' : 'Replay'
  const tagTitle =
    s.source === 'offline'
      ? 'HeatTwin engine unreachable — offline fallback, no estimates'
      : s.clock === 'live'
        ? `${s.live.label ?? 'live HR'} — following the wall clock`
        : (s.replay.label ?? 'Demo playback of the plan forecast')
  const scrub = useReplayScrub(s.totalMinutes, s.minute)
  return (
    <div className="demobar glass glass--strong" role="toolbar" aria-label="Demo playback">
      <button
        className="demobar__play pressable"
        onClick={() => (s.running ? engine.pause() : engine.play())}
        aria-label={s.running ? 'Pause replay' : 'Play replay'}
      >
        {s.running ? <IconPause /> : <IconPlay />}
      </button>

      <div className="demobar__time">
        <div className="demobar__clock num">{clockLabel(s.startHour, s.minute)}</div>
        <div className="demobar__track" {...scrub} aria-label="Replay time" aria-valuetext={clockLabel(s.startHour, s.minute)}>
          <div className="demobar__fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>

      <div className="demobar__speeds" role="radiogroup" aria-label="Replay speed">
        {SPEEDS.map((v) => (
          <button
            key={v}
            role="radio"
            aria-checked={s.speed === v}
            className={`demobar__speed num ${s.speed === v ? 'is-on' : ''}`}
            onClick={() => engine.setSpeed(v)}
          >
            {s.speed === v && (
              <motion.span layoutId="speed-thumb" className="demobar__thumb" transition={spring.ui} />
            )}
            <span>{v}×</span>
          </button>
        ))}
      </div>

      <button
        className="demobar__btn pressable"
        onClick={() => skipTo != null && engine.seek(Math.max(s.minute, skipTo))}
        title={skipTo != null ? `Skip ahead to minute ${Math.round(skipTo)}` : 'No crossing in the engine forecast'}
      >
        <IconSkip width={16} height={16} />
        <span>Skip to heat</span>
      </button>
      <button className="demobar__icon pressable" onClick={() => engine.reset()} aria-label="Reset replay">
        <IconReset width={18} height={18} />
      </button>
      <span className="demobar__tag" title={tagTitle}>{tag}</span>
    </div>
  )
}
