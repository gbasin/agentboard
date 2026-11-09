import { expect, test } from 'bun:test'
import { waitForTmux } from './tmux-ready'

test('requires three consecutive responsive probes after a cold-start timeout', async () => {
  const replies = [false, true, false, true, true, true]
  let calls = 0
  await waitForTmux({ budgetMs: 1000, intervalMs: 0, probe: async () => replies[calls++]! })
  expect(calls).toBe(6)
})

test('bounds an unresponsive host and caps each probe to remaining time', async () => {
  const timeouts: number[] = []
  await expect(waitForTmux({ budgetMs: 35, probeMs: 3000, intervalMs: 0, probe: async timeout => {
    timeouts.push(timeout)
    await Bun.sleep(timeout)
    return false
  } })).rejects.toThrow('CI startup budget')
  expect(timeouts.length).toBeGreaterThan(0)
  expect(timeouts.every(timeout => timeout > 0 && timeout <= 35)).toBe(true)
})

test('missing executable errors fail immediately rather than retrying', async () => {
  let calls = 0
  await expect(waitForTmux({ probe: async () => { calls++; throw new Error('not found') } })).rejects.toThrow('not found')
  expect(calls).toBe(1)
})
