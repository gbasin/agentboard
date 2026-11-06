import { describe, expect, test } from 'bun:test'
import { LogReconciliation } from '../logReconciliation'

const logs = (count: number) => Array.from({ length: count }, (_, i) => ({ logPath: `s${i}` }))

describe('bounded reconciliation', () => {
  test('continuous arrivals do not starve the frozen sweep; hot updates arrive every poll', () => {
    const selector = new LogReconciliation()
    const original = logs(30)
    const seen = new Set<string>()
    for (let cycle = 0; cycle < 16; cycle++) {
      const hot = { logPath: `new-${cycle}` }
      const batch = selector.select([hot, ...original], 5, 'roots')
      expect(batch).toHaveLength(5)
      expect(batch).toContain(hot)
      batch.forEach((entry) => seen.add(entry.logPath))
    }
    expect(original.every((entry) => seen.has(entry.logPath))).toBe(true)
  })

  test('one-entry budget alternates recent activity and reconciliation', () => {
    const selector = new LogReconciliation()
    const original = logs(4)
    const seen = new Set<string>()
    for (let cycle = 0; cycle < 10; cycle++) {
      const hot = { logPath: `hot-${cycle}` }
      const batch = selector.select([hot, ...original], 1, 'roots')
      expect(batch).toHaveLength(1)
      if (cycle % 2 === 0) expect(batch[0]).toBe(hot)
      seen.add(batch[0]!.logPath)
    }
    expect(original.every((entry) => seen.has(entry.logPath))).toBe(true)
  })

  test('deleted paths release capacity and changing roots resets the sweep', () => {
    const selector = new LogReconciliation()
    selector.select(logs(30), 5, 'old')
    expect(selector.select([{ logPath: 'other' }], 5, 'new')).toEqual([{ logPath: 'other' }])
    expect(selector.select([], 5, 'new')).toEqual([])
  })
})
