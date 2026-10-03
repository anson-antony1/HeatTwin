import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { motion, Reorder, useDragControls, useMotionValue, useReducedMotion, useVelocity } from 'motion/react'
import type { ContractDrill, ContractGear, ContractIntensity } from '../data/llmPlan'
import { clockLabel } from '../lib/heat'
import { ease, spring } from '../lib/motion'
import { useMotionBlur } from '../lib/useMotionBlur'
import { useSize } from '../lib/useSize'
import './PlanEditor.css'

// Video-editor-style practice timeline. Clips are drills: drag a clip to move
// it (the others slide out of the way), drag its right edge to trim, double-
// click the name to rename. The inspector edits the selected clip. ⌘Z undoes.

const INTENSITIES: { id: ContractIntensity; label: string }[] = [
  { id: 'rest', label: 'Rest' },
  { id: 'light', label: 'Light' },
  { id: 'moderate', label: 'Moderate' },
  { id: 'hard', label: 'Hard' },
  { id: 'max', label: 'Max' },
]
const GEARS: { id: ContractGear; label: string }[] = [
  { id: 'none', label: 'No pads' },
  { id: 'helmet', label: 'Helmet' },
  { id: 'helmet_shoulder_pads', label: 'Shells' },
  { id: 'full_pads', label: 'Full pads' },
]
const PRIORITIES: { id: 1 | 2 | 3; label: string }[] = [
  { id: 1, label: 'Must keep' },
  { id: 2, label: 'Normal' },
  { id: 3, label: 'Optional' },
]

const MIN_CLIP = 1
const MAX_CLIP = 90

let seq = 0
const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`

const total = (ds: ContractDrill[]) => ds.reduce((s, d) => s + d.duration_min, 0)

interface Props {
  initial: ContractDrill[]
  startHour: number
  initialSelected?: string | null
  saving: boolean
  error: string | null
  onCancel: () => void
  onSave: (drills: ContractDrill[]) => void
}

export function PlanEditor({ initial, startHour, initialSelected = null, saving, error, onCancel, onSave }: Props) {
  const [drills, setDrills] = useState<ContractDrill[]>(() => initial.map((d) => ({ ...d })))
  const [selected, setSelected] = useState<string | null>(initialSelected ?? initial[0]?.id ?? null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const history = useRef<ContractDrill[][]>([])
  const [undoCount, setUndoCount] = useState(0)
  const remember = (snapshot: ContractDrill[]) => {
    history.current.push(snapshot)
    if (history.current.length > 50) history.current.shift()
    setUndoCount(history.current.length)
  }
  const [trackRef, { width }] = useSize<HTMLDivElement>()
  const [trimming, setTrimming] = useState(false)

  // Fit the whole session to the track; frozen while trimming so the clip
  // under the pointer doesn't rescale out from under it.
  const fitScale = width > 0 ? (width - 8) / Math.max(30, total(drills)) : 6
  const [scale, setScale] = useState(fitScale)
  useLayoutEffect(() => {
    if (!trimming) setScale(fitScale) // eslint-disable-line react-hooks/set-state-in-effect
  }, [fitScale, trimming])

  const commit = (next: ContractDrill[]) => {
    remember(drills)
    setDrills(next)
  }
  const undo = () => {
    const prev = history.current.pop()
    setUndoCount(history.current.length)
    if (prev) setDrills(prev)
  }
  const update = (id: string, patch: Partial<ContractDrill>) =>
    commit(drills.map((d) => (d.id === id ? { ...d, ...patch } : d)))

  const remove = (id: string) => {
    const i = drills.findIndex((d) => d.id === id)
    const next = drills.filter((d) => d.id !== id)
    commit(next)
    setSelected(next[Math.min(i, next.length - 1)]?.id ?? null)
  }

  const add = (kind: 'drill' | 'break') => {
    const at = selected ? drills.findIndex((d) => d.id === selected) + 1 : drills.length
    const gear = drills[at - 1]?.gear ?? 'helmet'
    const d: ContractDrill =
      kind === 'break'
        ? { id: newId('b'), name: 'Water break', duration_min: 4, intensity: 'rest', gear, shade: true, is_break: true, priority: 1, movable: true }
        : { id: newId('d'), name: 'New drill', duration_min: 10, intensity: 'moderate', gear, shade: false, is_break: false, priority: 2, movable: true }
    const next = [...drills.slice(0, at), d, ...drills.slice(at)]
    commit(next)
    setSelected(d.id)
    if (kind === 'drill') setRenaming(d.id)
  }

  const duplicate = (id: string) => {
    const i = drills.findIndex((d) => d.id === id)
    const copy = { ...drills[i], id: newId(drills[i].is_break ? 'b' : 'd') }
    commit([...drills.slice(0, i + 1), copy, ...drills.slice(i + 1)])
    setSelected(copy.id)
  }

  // Keyboard: ⌘Z undo, Delete removes the selected clip, ←/→ moves selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        undo()
        return
      }
      if (typing || !selected) return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove(selected)
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const i = drills.findIndex((d) => d.id === selected)
        const j = Math.max(0, Math.min(drills.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))
        setSelected(drills[j].id)
      } else if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const sel = drills.find((d) => d.id === selected) ?? null
  const mins = total(drills)
  const tickEvery = mins > 150 ? 10 : 5
  const starts = drills.map((_, i) => drills.slice(0, i).reduce((s, d) => s + d.duration_min, 0))

  return (
    <div className="editor">
      <div className="editor__bar">
        <div>
          <div className="eyebrow">Editing plan</div>
          <div className="display-sm num">
            {Math.round(mins)} min · {drills.length} blocks · ends {clockLabel(startHour, mins)}
          </div>
        </div>
        <div className="editor__actions">
          <button className="btn btn--quiet pressable" onClick={() => add('drill')}>
            + Drill
          </button>
          <button className="btn btn--quiet pressable" onClick={() => add('break')}>
            + Water break
          </button>
          <span className="editor__sep" aria-hidden="true" />
          <button className="btn btn--quiet pressable" onClick={undo} disabled={undoCount === 0} title="Undo (⌘Z)">
            Undo
          </button>
          <button className="btn btn--quiet pressable" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--ink pressable" onClick={() => onSave(drills)} disabled={saving || drills.length === 0}>
            {saving ? (
              <>
                <span className="spinner" aria-hidden="true" /> Modeling…
              </>
            ) : (
              'Save & model'
            )}
          </button>
        </div>
      </div>

      {error && <div className="editor__error">{error}</div>}

      <div className="editor__timeline" ref={trackRef}>
        {/* Ruler */}
        <div className="ruler" aria-hidden="true">
          {Array.from({ length: Math.floor(mins / tickEvery) + 1 }, (_, i) => i * tickEvery).map((m) => (
            <span
              key={m}
              className={`ruler__tick ${m % 15 === 0 ? 'is-major' : ''}`}
              style={{ transform: `translateX(${m * scale}px)` }}
            >
              {m % 15 === 0 && <span className="ruler__label num">{clockLabel(startHour, m).replace(/ (AM|PM)/, '')}</span>}
            </span>
          ))}
        </div>

        <Reorder.Group axis="x" values={drills} onReorder={(next) => setDrills(next)} className="track" as="div">
          {drills.map((d, i) => (
            <Clip
              key={d.id}
              d={d}
              start={starts[i]}
              scale={scale}
              selected={d.id === selected}
              renaming={d.id === renaming}
              onSelect={() => setSelected(d.id)}
              onDragStart={() => remember(drills)}
              onRenameStart={() => setRenaming(d.id)}
              onRename={(name) => {
                setRenaming(null)
                if (name.trim() && name.trim() !== d.name) update(d.id, { name: name.trim() })
              }}
              onTrimStart={() => {
                remember(drills)
                setTrimming(true)
              }}
              onTrim={(m) => setDrills((ds) => ds.map((x) => (x.id === d.id ? { ...x, duration_min: m } : x)))}
              onTrimEnd={() => setTrimming(false)}
            />
          ))}
        </Reorder.Group>
      </div>

      <div className="editor__hint faint">
        Drag a block to move it · drag its right edge to change length · double-click to rename · ⌘Z to undo
      </div>

      {sel && (
        <motion.div
          key={sel.id}
          className="inspector"
          initial={{ opacity: 0, transform: 'translateY(6px)' }}
          animate={{ opacity: 1, transform: 'translateY(0px)' }}
          transition={{ duration: 0.2, ease: ease.out }}
        >
          <label className="field field--name">
            <span className="eyebrow">Name</span>
            <input
              value={sel.name}
              onChange={(e) => setDrills((ds) => ds.map((x) => (x.id === sel.id ? { ...x, name: e.target.value } : x)))}
              onFocus={() => remember(drills)}
              maxLength={80}
            />
          </label>

          <div className="field">
            <span className="eyebrow">Length</span>
            <div className="stepper">
              <button className="pressable" onClick={() => update(sel.id, { duration_min: Math.max(MIN_CLIP, sel.duration_min - 1) })} aria-label="One minute shorter">
                −
              </button>
              <span className="num">{sel.duration_min}′</span>
              <button className="pressable" onClick={() => update(sel.id, { duration_min: Math.min(MAX_CLIP, sel.duration_min + 1) })} aria-label="One minute longer">
                +
              </button>
            </div>
          </div>

          {!sel.is_break && (
            <Segmented
              label="Intensity"
              options={INTENSITIES.filter((o) => o.id !== 'rest')}
              value={sel.intensity}
              onChange={(v) => update(sel.id, { intensity: v })}
              group={`int-${sel.id}`}
            />
          )}
          <Segmented label="Gear" options={GEARS} value={sel.gear} onChange={(v) => update(sel.id, { gear: v })} group={`gear-${sel.id}`} />
          <Segmented
            label="Priority"
            options={PRIORITIES}
            value={sel.priority}
            onChange={(v) => update(sel.id, { priority: v })}
            group={`pri-${sel.id}`}
          />

          <div className="field field--toggles">
            <label className="toggle">
              <input
                type="checkbox"
                checked={sel.is_break}
                onChange={(e) => update(sel.id, { is_break: e.target.checked, intensity: e.target.checked ? 'rest' : 'moderate' })}
              />
              Water break
            </label>
            <label className="toggle">
              <input type="checkbox" checked={sel.shade} onChange={(e) => update(sel.id, { shade: e.target.checked })} />
              In shade
            </label>
            <label className="toggle">
              <input type="checkbox" checked={!sel.movable} onChange={(e) => update(sel.id, { movable: !e.target.checked })} />
              Locked in place
            </label>
          </div>

          <div className="inspector__end">
            <button className="btn btn--quiet pressable" onClick={() => duplicate(sel.id)}>
              Duplicate
            </button>
            <button className="btn btn--quiet btn--danger pressable" onClick={() => remove(sel.id)}>
              Delete
            </button>
          </div>
        </motion.div>
      )}
    </div>
  )
}

function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  group,
}: {
  label: string
  options: { id: T; label: string }[]
  value: T
  onChange: (v: T) => void
  group: string
}) {
  return (
    <div className="field">
      <span className="eyebrow">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.id)}
            role="radio"
            aria-checked={o.id === value}
            className={`seg__btn ${o.id === value ? 'is-on' : ''}`}
            onClick={() => onChange(o.id)}
          >
            {o.id === value && <motion.span layoutId={group} className="seg__thumb" transition={spring.ui} />}
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Clip({
  d,
  start,
  scale,
  selected,
  renaming,
  onSelect,
  onDragStart,
  onRenameStart,
  onRename,
  onTrimStart,
  onTrim,
  onTrimEnd,
}: {
  d: ContractDrill
  start: number
  scale: number
  selected: boolean
  renaming: boolean
  onSelect: () => void
  onDragStart: () => void
  onRenameStart: () => void
  onRename: (name: string) => void
  onTrimStart: () => void
  onTrim: (minutes: number) => void
  onTrimEnd: () => void
}) {
  const reduce = useReducedMotion()
  const controls = useDragControls()
  const x = useMotionValue(0)
  // Horizontal motion blur while a clip is flung across the track.
  const { ref, filter } = useMotionBlur<HTMLDivElement>(useVelocity(x), 'x', { scale: 0.004, max: 3 })
  const trim = useRef<{ x0: number; m0: number } | null>(null)
  const [draft, setDraft] = useState(d.name)

  const startTrim = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    trim.current = { x0: e.clientX, m0: d.duration_min }
    onSelect()
    onTrimStart()
  }

  return (
    <Reorder.Item
      value={d}
      as="div"
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      ref={ref}
      className={`clip clip--${d.is_break ? 'break' : d.intensity} ${selected ? 'is-selected' : ''}`}
      style={{ width: Math.max(18, d.duration_min * scale - 4), x }}
      layout="position"
      transition={reduce ? { duration: 0 } : spring.move}
      whileDrag={{ scale: 1.03, boxShadow: '0 16px 40px rgb(40 30 80 / 0.22)', zIndex: 5 }}
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        onSelect()
        if (!renaming) controls.start(e)
      }}
      onDoubleClick={onRenameStart}
      title={`${d.name} · ${d.duration_min} min`}
    >
      {filter}
      <span className="clip__body">
        {renaming ? (
          <input
            className="clip__rename"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => onRename(draft)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRename(draft)
              if (e.key === 'Escape') {
                setDraft(d.name)
                onRename(d.name)
              }
            }}
            maxLength={80}
          />
        ) : (
          <span className="clip__name">{d.is_break ? (d.shade ? 'Water · shade' : 'Water') : d.name}</span>
        )}
        <span className="clip__meta num">
          {d.duration_min}′ · {Math.round(start)}–{Math.round(start + d.duration_min)}
        </span>
      </span>
      <span
        className="clip__trim"
        role="slider"
        aria-label={`Length of ${d.name}`}
        aria-valuemin={MIN_CLIP}
        aria-valuemax={MAX_CLIP}
        aria-valuenow={d.duration_min}
        onPointerDown={startTrim}
        onPointerMove={(e) => {
          if (!trim.current) return
          const m = Math.round(trim.current.m0 + (e.clientX - trim.current.x0) / scale)
          onTrim(Math.max(MIN_CLIP, Math.min(MAX_CLIP, m)))
        }}
        onPointerUp={() => {
          trim.current = null
          onTrimEnd()
        }}
        onPointerCancel={() => {
          trim.current = null
          onTrimEnd()
        }}
      />
    </Reorder.Item>
  )
}
