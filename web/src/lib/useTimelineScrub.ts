import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { engine } from '../data/engine'

// Drag-or-click scrubbing for a horizontal practice timeline, like a video
// scrubber: press anywhere to jump there, drag to move, the playhead tracks the
// pointer 1:1. Playback pauses while scrubbing and resumes on release if it
// was playing. Arrow keys step a minute (Shift: 5).

export function useTimelineScrub(totalMinutes: number) {
  const [scrubbing, setScrubbing] = useState(false)
  const wasRunning = useRef(false)

  const minuteAt = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    return f * totalMinutes
  }

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    wasRunning.current = engine.getSnapshot().running
    if (wasRunning.current) engine.pause()
    setScrubbing(true)
    engine.seek(minuteAt(e.currentTarget, e.clientX))
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    if (!scrubbing) return
    engine.seek(minuteAt(e.currentTarget, e.clientX))
  }

  const end = () => {
    if (!scrubbing) return
    setScrubbing(false)
    if (wasRunning.current) engine.play()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const step = e.shiftKey ? 5 : 1
    const now = engine.getSnapshot().minute
    if (e.key === 'ArrowRight') engine.seek(Math.floor(now) + step)
    else if (e.key === 'ArrowLeft') engine.seek(Math.max(0, Math.ceil(now) - step))
    else if (e.key === 'Home') engine.seek(0)
    else if (e.key === 'End') engine.seek(totalMinutes)
    else return
    e.preventDefault()
  }

  return {
    scrubbing,
    bind: {
      onPointerDown,
      onPointerMove,
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown,
      role: 'slider' as const,
      tabIndex: 0,
      'aria-valuemin': 0,
      'aria-valuemax': Math.round(totalMinutes),
    },
  }
}
