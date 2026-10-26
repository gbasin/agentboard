import { expect, test } from 'bun:test'
import { serializedPtySpawn } from '../relay/ptySpawnLock'

const macTest = process.platform === 'darwin' ? test : test.skip
const fixture = new URL('./fixtures/ptySpawnLockWorker.ts', import.meta.url).href

async function runWorker(lock: SharedArrayBuffer, counters: SharedArrayBuffer, fail = false) {
  const worker = new Worker(fixture)
  try {
    return await new Promise<{ ok: boolean; error?: string; lock: number }>((resolve, reject) => {
      worker.onmessage = event => resolve(event.data)
      worker.onerror = reject
      worker.postMessage({ lock, counters, fail })
    })
  } finally {
    worker.terminate()
  }
}

test('non-terminal subprocesses bypass the PTY lock', () => {
  const lock = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(lock, 0, 1)
  const result = serializedPtySpawn(lock, (() => ({ pid: 42 })) as never)([], {})
  expect(result.pid).toBe(42)
  expect(lock[0]).toBe(1)
})

macTest('main thread cannot block on a terminal spawn lock', () => {
  const spawn = serializedPtySpawn(new Int32Array(new SharedArrayBuffer(4)))
  expect(() => spawn([], { terminal: { data() {} } })).toThrow('only run in terminal workers')
})

macTest('concurrent terminal workers enter native spawn one at a time', async () => {
  const lock = new SharedArrayBuffer(4)
  const counters = new SharedArrayBuffer(8)
  const results = await Promise.all(Array.from({ length: 6 }, () => runWorker(lock, counters)))
  expect(results.every(result => result.ok)).toBe(true)
  expect([...new Int32Array(counters)]).toEqual([0, 0])
  expect(new Int32Array(lock)[0]).toBe(0)
})

macTest('native spawn failure releases the lock for the next worker', async () => {
  const lock = new SharedArrayBuffer(4)
  const counters = new SharedArrayBuffer(8)
  const failed = await runWorker(lock, counters, true)
  expect(failed.ok).toBe(false)
  expect(failed.error).toContain('native spawn failed')
  expect(failed.lock).toBe(0)
  expect((await runWorker(lock, counters)).ok).toBe(true)
})

macTest('timeout does not release a lock owned by another worker', async () => {
  const lock = new SharedArrayBuffer(4)
  Atomics.store(new Int32Array(lock), 0, 1)
  const result = await runWorker(lock, new SharedArrayBuffer(8))
  expect(result.ok).toBe(false)
  expect(result.error).toContain('Timed out waiting for PTY creation')
  expect(new Int32Array(lock)[0]).toBe(1)
}, 7000)
