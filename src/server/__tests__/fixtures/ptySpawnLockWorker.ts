import { serializedPtySpawn } from '../../relay/ptySpawnLock'

self.onmessage = (event: MessageEvent<{ lock: SharedArrayBuffer; counters: SharedArrayBuffer; fail: boolean }>) => {
  const lock = new Int32Array(event.data.lock)
  const counters = new Int32Array(event.data.counters)
  const spawn = serializedPtySpawn(lock, (() => {
    if (event.data.fail) throw new Error('native spawn failed')
    const active = Atomics.add(counters, 0, 1) + 1
    if (active > 1) Atomics.store(counters, 1, 1)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    Atomics.sub(counters, 0, 1)
    return { pid: 123 }
  }) as never)
  try {
    spawn([], { terminal: { data() {} } })
    self.postMessage({ ok: true, lock: Atomics.load(lock, 0) })
  } catch (error) {
    self.postMessage({ ok: false, error: String(error), lock: Atomics.load(lock, 0) })
  }
}
