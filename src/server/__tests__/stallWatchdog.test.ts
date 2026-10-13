import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
let StallGapTracker: typeof import('../stallWatchdog').StallGapTracker
let StallWatchdog: typeof import('../stallWatchdog').StallWatchdog

beforeAll(async () => {
  globalThis.Worker = WorkerMock as unknown as typeof Worker
  const mod = await import('../stallWatchdog')
  StallGapTracker = mod.StallGapTracker
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
    now = 1999
    expect(tracker.check()).toBeNull()
  })

  test('returns the gap when the heartbeat is overdue past threshold', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    now = 2500
    expect(tracker.check()).toBe(2500)
  })

  test('cooldown suppresses repeat triggers until it elapses', () => {
    let now = 0
    const tracker = new StallGapTracker({
      thresholdMs: 2000,
      cooldownMs: 60_000,
      now: () => now,
    })
    now = 5000
    expect(tracker.check()).toBe(5000)
    // Stall ends and a new one starts inside the cooldown window.
    tracker.beat()
    now = 10_000
    expect(tracker.check()).toBeNull()
    // Cooldown over: a fresh stall (4s gap since the last beat) triggers.
    now = 66_000
    tracker.beat()
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

  test('beat() forwards heartbeat messages to the worker', () => {
    WorkerMock.instances = []
    const watchdog = new StallWatchdog(makeConfig())
    watchdog.start()
    watchdog.beat()
    watchdog.beat()
    const worker = WorkerMock.instances[0]
    expect(
      worker.messages.filter(
        (m) => (m as StallWatchdogWorkerRequest).kind === 'beat'
      )
    ).toHaveLength(2)
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
