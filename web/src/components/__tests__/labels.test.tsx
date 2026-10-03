import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProvenanceLabels } from '../ProvenanceLabels'
import { OfflineBadge, OfflineBanner } from '../OfflineBadge'
import { OFFLINE_LABEL } from '../../offline/standIn'

const labels = [
  'estimate — planning only',
  'forecast is fixture',
  'synthetic plan (fixture)',
  'synthetic roster',
  'demo mode: forecast pinned to the cached NWS fixture',
  'uses unverified constants: drill_met (DESIGN)',
]

describe('<ProvenanceLabels/>', () => {
  it('always shows "estimate — planning only" first, once', () => {
    const html = renderToStaticMarkup(<ProvenanceLabels labels={labels} />)
    expect(html.indexOf('estimate — planning only')).toBeGreaterThan(-1)
    expect(html.split('estimate — planning only')).toHaveLength(2)
    expect(html.indexOf('estimate — planning only')).toBeLessThan(html.indexOf('forecast is fixture'))
  })

  it('is compact by default and says how many more there are', () => {
    const html = renderToStaticMarkup(<ProvenanceLabels labels={labels} />)
    expect(html).toContain('synthetic roster')
    expect(html).not.toContain('uses unverified constants')
    expect(html).toContain('+2 more')
  })

  it('can omit the estimate chip for non-temperature cards', () => {
    const html = renderToStaticMarkup(<ProvenanceLabels labels={['no field recording yet']} estimate={false} />)
    expect(html).not.toContain('estimate — planning only')
    expect(html).toContain('no field recording yet')
  })
})

describe('<OfflineBadge/>', () => {
  it('says OFFLINE FALLBACK — not the validated model', () => {
    expect(renderToStaticMarkup(<OfflineBadge />)).toContain(OFFLINE_LABEL)
    expect(renderToStaticMarkup(<OfflineBanner />)).toContain(OFFLINE_LABEL)
    expect(renderToStaticMarkup(<OfflineBadge compact />)).toContain('OFFLINE FALLBACK')
  })
})
