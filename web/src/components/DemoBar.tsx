import { motion } from 'motion/react'
import { engine, replayLabel, useSession } from '../data/engine'
import { clockLabel } from '../lib/heat'
import { spring } from '../lib/motion'
import { IconPause, IconPlay, IconReset, IconSkip } from './Icons'
import './DemoBar.css'

const SPEEDS = [1, 4, 10]

// Demo transport. Practice minutes run `speed`× per real second so a
// two-hour session plays in two minutes on stage. Labelled "demo playback —
// not live" so nobody mistakes it for a live feed.
export function DemoBar() {
  const s = useSession()
  const progress = s.totalMinutes > 0 ? s.minute / s.totalMinutes : 0
  // Skip to the first minute the engine's HR-calibration gates flag someone;
  // without a replay, to the first p95 crossing in the engine forecast.
  const crossings = Object.values(s.athletes)
    .map((a) => a.firstCrossMin)
    .filter((m): m is number => m != null)
  const skipTo = s.firstFlagMinute ?? (crossings.length ? Math.min(...crossings) : null)
  const skipWhat = s.firstFlagMinute != null ? 'first engine flag in the HR replay' : 'first p95 crossing in the engine forecast'
  const replay = replayLabel(s.replay)
  return (
    <div className="demobar glass glass--strong" role="toolbar" aria-label="Demo playback">
      <button
        className="demobar__play pressable"
        onClick={() => (s.running ? engine.pause() : engine.play())}
        aria-label={s.running ? 'Pause demo playback' : 'Play demo playback'}
      >
        {s.running ? <IconPause /> : <IconPlay />}
      </button>

      <div className="demobar__time">
        <div className="demobar__clock num">{clockLabel(s.startHour, s.minute)}</div>
        <div className="demobar__track" aria-hidden="true">
          <div className="demobar__fill" style={{ transform: `scaleX(${progress})` }} />
        </div>
      </div>

      <div className="demobar__speeds" role="radiogroup" aria-label="Playback speed">
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
        disabled={skipTo == null}
        title={skipTo != null ? `Skip to minute ${Math.round(skipTo)} (${skipWhat})` : undefined}
      >
        <IconSkip width={16} height={16} />
        <span>{s.firstFlagMinute != null ? 'Skip to first flag' : 'Skip to first crossing'}</span>
      </button>
      <button className="demobar__icon pressable" onClick={() => engine.reset()} aria-label="Reset demo playback">
        <IconReset width={18} height={18} />
      </button>
      <span className="demobar__tag">
        demo playback — not live
        {replay && <span className="demobar__replay">{replay}</span>}
      </span>
    </div>
  )
}
