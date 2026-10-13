import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { StallGapTracker } from '../stallGapTracker'
import type { StallWatchdogWorkerRequest } from '../stallWatchdogWorker'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  messages: unknown[] = []

  constructor(
    public url: string,
    public options?: WorkerOptions
  ) {
    WorkerMock.instances.push(this)
  }

  postMessage(payload: unknown) {
    this.messages.push(payload)
  }
}

const originalWorker = globalThis.Worker
let StallWatchdog: typeof import('../stallWatchdog').StallWatchdog

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  const mod = await import('../stallWatchdog')
  StallWatchdog = mod.StallWatchdog
})

afterAll(() => {
  globalThis.Worker = originalWorker
})

function makeConfig(
  overrides: Partial<import('../stallWatchdog').StallWatchdogConfig> = {}
): import('../stallWatchdog').StallWatchdogConfig {
  return {
    enabled: true,
    pid: 1234,
    sampleDir: '/tmp/stall-samples-test',
    thresholdMs: 2000,
    sampleSeconds: 1,
    cooldownMs: 60_000,
    maxSamples: 20,
    checkIntervalMs: 250,
    ...overrides,
  }
}

describe('StallGapTracker', () => {
  test('reports nothing while the heartbeat gap stays under threshold', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.beat(0)
    now = 1999
    expect(tracker.check()).toBeNull()
  })

  test('returns the gap when the newest sent timestamp is overdue', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.beat(0)
    now = 2500
    expect(tracker.check()).toBe(2500)
  })

  test('a stale queued beat does not mask an in-progress stall', () => {
    // The worker was starved and only now drains its queue: the beat it
    // processes carries a send time from before the stall began, so the gap
    // still measures the main thread's silence rather than delivery delay.
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.beat(0)
    now = 10_000
    tracker.beat(500) // queued beat, sent 9.5s ago
    expect(tracker.check()).toBe(9_500)
  })

  test('a fresh queued beat clears the gap even if processed late', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.beat(0)
    now = 10_000
    tracker.beat(9_900) // sent 100ms ago; main is alive
    expect(tracker.check()).toBeNull()
  })

  test('cooldown suppresses repeat triggers until it elapses', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.beat(0)
    now = 5_000
    expect(tracker.check()).toBe(5_000)
    // Stall ends and a new one starts inside the cooldown window.
    tracker.beat(5_000)
    now = 10_000
    expect(tracker.check()).toBeNull()
    // Cooldown over: a fresh stall (4s gap since the last beat) triggers.
    now = 66_000
    tracker.beat(66_000)
    now = 70_000
    expect(tracker.check()).toBe(4_000)
  })

  test('disable() stops sampling entirely', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    tracker.disable()
    now = 999_999
    expect(tracker.check()).toBeNull()
  })
})

describe('StallWatchdog', () => {
  test('start() spawns the worker and sends init once', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig())
    watchdog.start()
    expect(WorkerMock.instances).toHaveLength(1)
    const init = WorkerMock.instances[0].messages[0] as Extract<
      StallWatchdogWorkerRequest,
      { kind: 'init' }
    >
    expect(init.kind).toBe('init')
    expect(init.pid).toBe(1234)
    expect(init.thresholdMs).toBe(2000)
    watchdog.start()
    expect(WorkerMock.instances).toHaveLength(1)
    watchdog.dispose()
  })

  test('beat() forwards the send timestamp to the worker', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig())
    watchdog.start()
    watchdog.beat()
    watchdog.beat()
    const worker = WorkerMock.instances[0]
    const beats = worker.messages.filter(
      (m): m is Extract<StallWatchdogWorkerRequest, { kind: 'beat' }> =>
        (m as StallWatchdogWorkerRequest).kind === 'beat'
    )
    expect(beats).toHaveLength(2)
    expect(typeof beats[0].sentAt).toBe('number')
    expect(beats[1].sentAt).toBeGreaterThanOrEqual(beats[0].sentAt)
    watchdog.dispose()
  })

  test('disabled config never spawns a worker', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig({ enabled: false }))
    watchdog.start()
    watchdog.beat()
    expect(WorkerMock.instances).toHaveLength(0)
    watchdog.dispose()
  })

  test('a worker error clears the reference and blocks restart', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig())
    watchdog.start()
    const worker = WorkerMock.instances[0]
    worker.onerror?.(new ErrorEvent('error', { message: 'boom' }))
    expect(worker.onmessage).toBeNull()
    // Beats no longer reach a worker, and start() will not retry.
    watchdog.beat()
    expect(worker.messages.filter((m) => (m as { kind: string }).kind === 'beat')).toHaveLength(0)
    watchdog.start()
    expect(WorkerMock.instances).toHaveLength(1)
    watchdog.dispose()
  })

  test('dispose() asks the worker to shut down and detaches handlers', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig())
    watchdog.start()
    watchdog.dispose()
    const worker = WorkerMock.instances[0]
    expect(
      worker.messages.some(
        (m) => (m as StallWatchdogWorkerRequest).kind === 'shutdown'
      )
    ).toBe(true)
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
    // Beats after dispose are dropped.
    watchdog.beat()
    expect(worker.messages.filter((m) => (m as { kind: string }).kind === 'beat')).toHaveLength(0)
  })
})
