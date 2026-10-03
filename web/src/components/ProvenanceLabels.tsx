import { useId, useState } from 'react'
import { ESTIMATE_LABEL } from '../data/constants'
import './ProvenanceLabels.css'

// The `labels` of the engine response a view is drawing ("synthetic plan
// (fixture)", "synthetic roster", "forecast is fixture", "replay", "synthetic
// HR (not a real athlete)", "AT-owned settings …", "uses unverified
// constants …"), as compact chips that expand to the full text.
// "estimate — planning only" is always shown first and never collapsed.

const COMPACT = 3

function tone(label: string): string {
  if (/offline fallback/i.test(label)) return 'offline'
  if (/synthetic|fixture|fictional|replay|demo mode|unverified|stand-in|TODO/i.test(label)) return 'warn'
  return ''
}

export function ProvenanceLabels({
  labels,
  title = 'Data provenance',
  estimate = true,
}: {
  labels: string[]
  title?: string
  /** Pin "estimate — planning only" (on for any view that shows core temperature). */
  estimate?: boolean
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const rest = [...new Set(labels.filter((l) => l && l !== ESTIMATE_LABEL))]
  const shown = open ? rest : rest.slice(0, COMPACT)
  const hidden = rest.length - shown.length

  return (
    <div className={`prov ${open ? 'is-open' : ''}`} aria-label={title}>
      <span className="prov__title">{title}</span>
      <ul className="prov__list" id={id}>
        {estimate && <li className="prov__chip prov__chip--estimate">{ESTIMATE_LABEL}</li>}
        {shown.map((l) => (
          <li key={l} className={`prov__chip prov__chip--${tone(l)}`} title={l}>
            {l}
          </li>
        ))}
      </ul>
      {rest.length > COMPACT && (
        <button className="prov__more linkbtn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `+${hidden} more`}
        </button>
      )}
    </div>
  )
}
