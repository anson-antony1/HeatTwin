import { describe, expect, it } from 'vitest'
import { nodeDemoActive, type NodeLatest } from './engineApi'
import { replayHeldNote, type ReplayInfo } from './engine'

const base: NodeLatest = { reading: null, series: [], file: null, labels: [] }
const replay = (status: ReplayInfo['status']): ReplayInfo =>
  ({ status, synthetic: false, label: null, file: null, athletes: [], error: null })

describe('sensor demo', () => {
  it('is active only while the engine reports a demo_version > 0', () => {
    expect(nodeDemoActive(null)).toBe(false)
    expect(nodeDemoActive(base)).toBe(false)
    expect(nodeDemoActive({ ...base, demo_version: 0 })).toBe(false)
    expect(nodeDemoActive({ ...base, demo_version: 3 })).toBe(true)
  })
  it('says why the HR replay is paused while the sensor drives the weather', () => {
    expect(replayHeldNote(replay('sensor'))).toMatch(/sensor demo/)
    expect(replayHeldNote(replay('ready'))).toBeNull()
  })
})
