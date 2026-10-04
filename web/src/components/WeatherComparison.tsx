import { zoneColor } from '../data/constants'
import { useDemoComparison, type ComparisonState } from '../data/comparison'
import type { DemoComparison, DemoComparisonRow } from '../data/engineApi'
import { ProvenanceLabels } from './ProvenanceLabels'
import './WeatherComparison.css'

// "Compare weather inputs" (Plan screen, decision 2): the same plan run under
// each weather input — the saved forecast the demo uses, live NWS WBGT, and
// live Liljegren WBGT — from GET /demo/comparison (CONTRACTS v1.4). A stored
// snapshot, not live. Every number in the table is a field of that response;
// the headline row (the saved forecast) is highlighted.

/** "Oct 3, 2:15 PM" in the viewer's time zone; "—" when the input has no fetch time. */
function fetchedLabel(iso: string | null): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Hourly WBGT behind the row's peak zone, for the zone cell's tooltip. */
function wbgtTitle(row: DemoComparisonRow): string | undefined {
  if (!row.wbgt_f_by_hour?.length) return undefined
  const hours = row.wbgt_f_by_hour.map(([t, f]) => `${/T(\d\d:\d\d)/.exec(t)?.[1] ?? t} ${f.toFixed(1)} °F`)
  return `WBGT by hour: ${hours.join(', ')}`
}

export function ComparisonTable({ data }: { data: DemoComparison }) {
  return (
    <>
      <div className="cmp__scroll">
        <table className="cmp__table">
          <thead>
            <tr>
              <th scope="col">Weather input</th>
              <th scope="col">Zone (peak)</th>
              <th scope="col">Athletes over (p95) before → after</th>
              <th scope="col">Load kept</th>
              <th scope="col">Changes</th>
              <th scope="col">Fetched</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const headline = r.key === data.headline
              return (
                <tr key={r.key} className={headline ? 'is-headline' : undefined} aria-current={headline ? 'true' : undefined}>
                  <th scope="row">
                    {r.input}
                    {headline && <span className="cmp__tag">headline · used in the demo</span>}
                  </th>
                  <td className="num" title={wbgtTitle(r)}>
                    <span className="cmp__zone" style={{ background: zoneColor(r.peak_zone) }} aria-hidden="true" />
                    Zone {r.peak_zone}
                  </td>
                  <td className="num">
                    {r.over_before} → {r.over_after}
                  </td>
                  <td className="num">{r.load_kept_pct.toFixed(1)}%</td>
                  <td className="num">
                    {r.changes}
                    {!r.feasible && <span className="cmp__tag cmp__tag--warn">no feasible plan</span>}
                  </td>
                  <td className="num cmp__time">{fetchedLabel(r.fetched_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ProvenanceLabels labels={data.labels} title="Comparison snapshot" />
    </>
  )
}

export function ComparisonBody({ state }: { state: ComparisonState }) {
  if (state.status === 'loading') return <p className="faint cmp__msg">Loading the comparison…</p>
  if (state.status === 'missing') return <p className="faint cmp__msg">comparison not generated yet</p>
  if (state.status === 'error') return <p className="faint cmp__msg">Comparison unavailable — {state.message}.</p>
  return <ComparisonTable data={state.data} />
}

export function WeatherComparison() {
  const state = useDemoComparison()
  return (
    <section className="glass cmp" aria-label="Compare weather inputs">
      <div className="cmp__head">
        <div className="eyebrow">Compare weather inputs</div>
        <p className="faint cmp__sub">
          The same plan under each weather input, then optimized — a stored snapshot (engine GET /demo/comparison), not
          live.{state.status === 'ready' ? ` Plan ${state.data.plan_id}.` : ''}
        </p>
      </div>
      <ComparisonBody state={state} />
    </section>
  )
}
