import { useEffect, useRef } from 'react'

// Live microphone levels for the waveform. Opens its own analyser on the mic
// while `active`, and writes bar heights straight to the DOM every frame
// (transform only) — no React re-render per frame.

export function useMicLevels(active: boolean, bars: number) {
  const containerRef = useRef<HTMLDivElement>(null)
  const levelRef = useRef(0)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    let raf = 0
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let cancelled = false

    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        if (cancelled) return stream.getTracks().forEach((t) => t.stop())
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.72
        ctx.createMediaStreamSource(stream).connect(analyser)
        const data = new Uint8Array(analyser.frequencyBinCount)
        const smooth = new Float32Array(bars)

        const tick = () => {
          analyser.getByteFrequencyData(data)
          const el = container
          // Voice lives in the low bins; spread them across the bars, mirrored from the centre.
          const usable = Math.floor(data.length * 0.55)
          let sum = 0
          for (let i = 0; i < bars; i++) {
            const fromCentre = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2)
            const bin = Math.floor(fromCentre * (usable - 1))
            const v = data[bin] / 255
            smooth[i] += (v - smooth[i]) * 0.35
            sum += smooth[i]
            const child = el?.children[i] as HTMLElement | undefined
            if (child) child.style.transform = `scaleY(${(0.12 + smooth[i] * 0.88).toFixed(3)})`
          }
          levelRef.current = sum / bars
          raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      } catch {
        /* no mic or permission denied — the recorder surfaces the error */
      }
    })()

    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      ctx?.close()
      levelRef.current = 0
      if (container) for (const c of Array.from(container.children)) (c as HTMLElement).style.transform = ''
    }
  }, [active, bars])

  return { containerRef, levelRef }
}
