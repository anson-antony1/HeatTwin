import './Background.css'

export type Tone = 'coach' | 'athlete' | 'alert'

// The mesh gradient from the Figma, as three stacked layers that crossfade by
// tone. Nothing drifts or loops — a full-viewport moving background is a
// vestibular trigger — the only motion is a slow opacity change when the
// state behind it genuinely changes (a heat alert warms the whole room).
export function Background({ tone }: { tone: Tone }) {
  return (
    <div className="bg" aria-hidden="true">
      <div className={`bg__layer bg__coach ${tone === 'coach' ? 'is-on' : ''}`} />
      <div className={`bg__layer bg__athlete ${tone === 'athlete' ? 'is-on' : ''}`} />
      <div className={`bg__layer bg__alert ${tone === 'alert' ? 'is-on' : ''}`} />
      <div className="bg__grain" />
    </div>
  )
}
