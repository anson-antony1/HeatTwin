import { fmtCF, noRectalNote, tubWithinText, type CwiTargets } from './targets'

// Pre-practice readiness checklist. Every item starts UNCHECKED; only the user ticks them, and
// HeatTwin cannot verify a tick. Ticks may be remembered for the rest of the same calendar day
// (localStorage, wrapped in try/catch) so they survive switching screens, and are ignored the
// next day.

export interface ChecklistItem {
  id: string
  label: string
  detail: string
}

export const CHECKLIST_IDS = ['tub', 'thermometer', 'path', 'phone', 'rectal'] as const
export type ChecklistId = (typeof CHECKLIST_IDS)[number]
export type Checked = Record<ChecklistId, boolean>

export function checklistItems(t: CwiTargets): ChecklistItem[] {
  const within = tubWithinText(t)
  const limit = t.tubWaterMaxC != null ? `KSI water limit: under ${fmtCF(t.tubWaterMaxC)}` : 'Check the water against the KSI limit'
  return [
    {
      id: 'tub',
      label: 'Tub filled with ice water, near the field',
      detail: within ? `KSI: tub within ${within} of each field` : 'KSI: tub set up before activity, close to each field',
    },
    { id: 'thermometer', label: 'Water thermometer in the tub', detail: limit },
    { id: 'path', label: 'Path to the tub clear', detail: 'Per your emergency action plan' },
    { id: 'phone', label: 'Phone and EMS address ready', detail: 'Per your emergency action plan' },
    {
      id: 'rectal',
      label: 'Rectal thermometer and trained staff available',
      detail: `Rectal temperature is the only basis for treatment decisions (KSI, MHSAA). ${noRectalNote(t)}`,
    },
  ]
}

export function initialChecked(): Checked {
  return { tub: false, thermometer: false, path: false, phone: false, rectal: false }
}

export function countChecked(c: Checked): number {
  return CHECKLIST_IDS.filter((id) => c[id]).length
}

export function localDateKey(d: Date = new Date()): string {
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

const KEY = 'heattwin.response.checklist.v1'

export function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Ticks saved earlier today, else all unchecked. Never throws. */
export function loadChecked(storage: Pick<Storage, 'getItem'> | null, today: string): Checked {
  const out = initialChecked()
  try {
    const raw = storage?.getItem(KEY)
    if (!raw) return out
    const j = JSON.parse(raw) as { date?: unknown; checked?: Record<string, unknown> }
    if (j.date !== today || typeof j.checked !== 'object' || j.checked === null) return out
    for (const id of CHECKLIST_IDS) out[id] = j.checked[id] === true
  } catch {
    /* unreadable storage: start unchecked */
  }
  return out
}

export function saveChecked(storage: Pick<Storage, 'setItem'> | null, today: string, checked: Checked): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ date: today, checked }))
  } catch {
    /* storage blocked: ticks stay in memory only */
  }
}
