import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { engine } from '../data/engine'

export function useReplayScrub(total: number, minute: number) {
  const pointer = useRef<number | null>(null)
  const seekFromPointer = (event: PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    engine.seek(Math.round(fraction * total))
  }
  return {
    role: 'slider' as const,
    tabIndex: 0,
    'aria-valuemin': 0,
    'aria-valuemax': Math.round(total),
    'aria-valuenow': Math.round(minute),
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      engine.pause()
      pointer.current = event.pointerId
      event.currentTarget.setPointerCapture(event.pointerId)
      seekFromPointer(event)
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (pointer.current === event.pointerId) seekFromPointer(event)
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      if (pointer.current === event.pointerId) pointer.current = null
    },
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (pointer.current === event.pointerId) pointer.current = null
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 5 : 1
      const target = event.key === 'ArrowLeft' ? minute - step
        : event.key === 'ArrowRight' ? minute + step
          : event.key === 'Home' ? 0
            : event.key === 'End' ? total : null
      if (target == null) return
      event.preventDefault()
      engine.pause()
      engine.seek(target)
    },
  }
}
