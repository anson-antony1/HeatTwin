import { useMemo } from 'react'
import { useEngineMeta } from '../data/engineMeta'
import { usePlanState } from '../data/planStore'
import { nearMargin } from '../data/selectors'
import type { SettingsResponse, SimulationResult } from '../data/engineApi'
import type { OfflineResult } from '../offline/standIn'
import type { HeatScale } from './heat'

/** Colour boundaries from engine numbers (stand-in placeholders only when offline). Null until the engine answers. */
export function heatScaleFrom(
  sim: SimulationResult | null,
  settings: SettingsResponse | null,
  offline: OfflineResult | null,
): HeatScale | null {
  if (sim) {
    const firsts = sim.athletes.map((a) => a.core_c_p50[0]).filter(Number.isFinite)
    const margin = nearMargin(settings, sim)
    const limit = sim.limit_core_c
    if (!firsts.length) return null
    return { floor: Math.min(...firsts), near: margin != null ? limit - margin : limit, limit }
  }
  if (offline) return { floor: offline.floorC, near: offline.limitC - offline.nearMarginC, limit: offline.limitC }
  return null
}

export function useHeatScale(): HeatScale | null {
  const p = usePlanState()
  const meta = useEngineMeta()
  return useMemo(() => heatScaleFrom(p.sim, meta.settings, p.sim ? null : p.offline), [p.sim, p.offline, meta.settings])
}

/** The AT-owned near band (°C) in use: GET /settings, else the settings the run used. */
export function useNearMargin(): number | null {
  const p = usePlanState()
  const meta = useEngineMeta()
  if (p.sim) return nearMargin(meta.settings, p.sim)
  return p.offline ? p.offline.nearMarginC : null
}
