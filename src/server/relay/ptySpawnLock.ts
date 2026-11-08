/** Bun 1.3.14/macOS concurrent PTY creation can leave the main thread's signals blocked. */
import { isMainThread } from 'node:worker_threads'
import type { TerminalProxyOptions } from '../terminal/types'

type Spawn = NonNullable<TerminalProxyOptions['spawn']>

export function serializedPtySpawn(lock: Int32Array, spawn: Spawn = Bun.spawn): Spawn {
  return (args, options) => {
    if (!options?.terminal || process.platform !== 'darwin') return spawn(args, options)
    if (isMainThread) throw new Error('PTY spawn lock must only run in terminal workers')
    const deadline = performance.now() + 5000
    while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) throw new Error('Timed out waiting for PTY creation')
      Atomics.wait(lock, 0, 1, remaining)
    }
    try {
      // Only synchronous native PTY creation is serialized, never setup or I/O.
      return spawn(args, options)
    } finally {
      Atomics.store(lock, 0, 0)
      Atomics.notify(lock, 0, 1)
    }
  }
}
