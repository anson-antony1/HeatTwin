import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComparisonBody, ComparisonTable } from '../WeatherComparison'
import { loadComparison } from '../../data/comparison'
import type { DemoComparison } from '../../data/engineApi'

// "Compare weather inputs" (decision 2) reads GET /demo/comparison (CONTRACTS v1.4). The values below are test-only
// numbers in that shape (deliberately not the real snapshot), so a number the panel invented would show up.

const SNAPSHOT: DemoComparison = {
  plan_id: 'plan-test',
  headline: 'saved_forecast',
  labels: ['estimate — planning only', 'snapshot written by scripts/demo_numbers.py', 'synthetic roster', 'live NWS fetched once, stored'],
  rows: [
    {
      key: 'saved_forecast',
      input: 'Saved forecast (fixture)',
      fetched_at: '2026-10-03T14:05:00-04:00',
      wbgt_f_by_hour: [['2026-10-04T15:00:00-04:00', 81.25]],
      peak_zone: 3,
      over_before: 13,
      over_after: 2,
      load_kept_pct: 64.25,
      changes: 17,
      feasible: true,
    },
    {
      key: 'live_nws_wbgt',
      input: 'Live NWS WBGT',
      fetched_at: null,
      wbgt_f_by_hour: [],
      peak_zone: 4,
      over_before: 11,
      over_after: 5,
      load_kept_pct: 58.5,
      changes: 23,
      feasible: false,
    },
  ],
}

afterEach(() => vi.unstubAllGlobals())

describe('<ComparisonTable/>', () => {
  it('shows one row per input with every number from the response', () => {
    const html = renderToStaticMarkup(<ComparisonTable data={SNAPSHOT} />)
    expect(html).toContain('Saved forecast (fixture)')
    expect(html).toContain('Live NWS WBGT')
    expect(html).toContain('Zone 3')
    expect(html).toContain('Zone 4')
    expect(html).toContain('13 → 2')
    expect(html).toContain('11 → 5')
    expect(html).toContain('64.3%') // 64.25 to one decimal
    expect(html).toContain('58.5%')
    expect(html).toContain('>17<')
    expect(html).toContain('>23<')
    expect(html).toContain('no feasible plan')
    expect(html).toContain('WBGT by hour: 15:00 81.3 °F')
  })

  it('highlights the headline row (the saved forecast) and shows the labels as chips', () => {
    const html = renderToStaticMarkup(<ComparisonTable data={SNAPSHOT} />)
    expect(html.match(/class="is-headline"/g)).toHaveLength(1)
    expect(html.indexOf('is-headline')).toBeLessThan(html.indexOf('Saved forecast (fixture)'))
    expect(html).toContain('headline · used in the demo')
    expect(html).toContain('estimate — planning only')
    expect(html).toContain('snapshot written by scripts/demo_numbers.py')
  })

  it('says "comparison not generated yet" on 404', () => {
    expect(renderToStaticMarkup(<ComparisonBody state={{ status: 'missing' }} />)).toContain('comparison not generated yet')
  })
})

describe('loadComparison', () => {
  it('GET /demo/comparison → ready', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify(SNAPSHOT), { status: 200 })
    })
    const s = await loadComparison()
    expect(urls).toEqual(['/engine/demo/comparison'])
    expect(s).toEqual({ status: 'ready', data: SNAPSHOT })
  })

  it('404 → missing; engine down → error', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 }))
    expect(await loadComparison()).toEqual({ status: 'missing' })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await loadComparison()).toEqual({ status: 'error', message: 'the comparison needs the engine' })
  })
})
