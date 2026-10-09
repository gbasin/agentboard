import { describe, expect, test } from 'bun:test'
import { mapWithConcurrency } from '../mapWithConcurrency'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('mapWithConcurrency', () => {
  test('never runs more than `limit` calls at once', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight -= 1
      return n * 10
    })
    expect(maxInFlight).toBe(2)
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70])
  })

  test('keeps input order when calls finish out of order', async () => {
    const gates = [deferred(), deferred(), deferred()]
    const run = mapWithConcurrency(['a', 'b', 'c'], 3, async (item, index) => {
      await gates[index]!.promise
      return `${item}${index}`
    })
    gates[2]!.resolve()
    gates[0]!.resolve()
    gates[1]!.resolve()
    expect(await run).toEqual(['a0', 'b1', 'c2'])
  })

  test('starts the next item as soon as a slot frees', async () => {
    const started: number[] = []
    const gates = [deferred(), deferred(), deferred()]
    const run = mapWithConcurrency([0, 1, 2], 2, async (n) => {
      started.push(n)
      await gates[n]!.promise
      return n
    })
    await Promise.resolve()
    expect(started).toEqual([0, 1])
    gates[1]!.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual([0, 1, 2])
    gates[0]!.resolve()
    gates[2]!.resolve()
    expect(await run).toEqual([0, 1, 2])
  })

  test('handles empty input and non-positive limits', async () => {
    expect(await mapWithConcurrency([], 2, async (n: number) => n)).toEqual([])
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n + 1)).toEqual([2, 3])
  })

  test('rejects when a call rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
  })
})
