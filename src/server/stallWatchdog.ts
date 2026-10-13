// stallWatchdog.ts - Samples this process's main thread mid-event-loop-stall.
//
// event_loop_lag only sees a stall after it ends — by then the blocked stack
// is gone, so the log can't name the synchronous call that held the loop
// (spawnSync on a wedged tmux server, sync SQLite, fs I/O under memory
// pressure). The watchdog lives in a Worker on its own thread: it watches the
// gap between heartbeat messages and, while the stall is still in progress,
// runs `sample <pid>` against this process so the report captures the frame
// actually doing the blocking. Reports land in <dataDir>/stall-samples/,
// newest `maxSamples` kept.
//
// `sample` is macOS-only — see config.stallWatchdog.enabled for the platform
// and test-env gates. Config: AGENTBOARD_STALL_WATCHDOG=0 disables,
// AGENTBOARD_STALL_WATCHDOG_MS sets the stall threshold.
import { logger } from './logger'
import type {
  StallWatchdogWorkerRequest,
  StallWatchdogWorkerResponse,
} from './stallWatchdogWorker'

export interface StallWatchdogConfig {
  enabled: boolean
  pid: number
  sampleDir: string
  /** Heartbeat gap that counts as a stall worth sampling. */
  thresholdMs: number
  /** `sample` capture duration in seconds. */
  sampleSeconds: number
  /** Minimum spacing between samples; stalls are common under chronic load. */
  cooldownMs: number
  /** Oldest reports are pruned beyond this count. */
  maxSamples: number
  /** How often the worker checks the heartbeat gap. */
  checkIntervalMs: number
}

/**
 * Heartbeat-gap bookkeeping, kept free of Worker/fs so it is unit-testable.
 * The worker thread owns an instance; beat() and check() both run there.
 */
export class StallGapTracker {
  private lastBeatAt: number
  private lastSampleAt = Number.NEGATIVE_INFINITY
  private disabled = false

  constructor(
    private readonly opts: {
      thresholdMs: number
      cooldownMs: number
      now?: () => number
    }
  ) {
    this.lastBeatAt = this.now()
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : performance.now()
  }

  beat(): void {
    this.lastBeatAt = this.now()
  }

  /**
   * Returns the heartbeat gap in ms when a sample should be taken: the gap
   * means the main thread is stalled *right now*. Cooldown starts at trigger
   * time, so a failing or ignored `sample` cannot spam; null otherwise.
   */
  check(): number | null {
    if (this.disabled) return null
    const now = this.now()
    const gap = now - this.lastBeatAt
    if (gap < this.opts.thresholdMs || now - this.lastSampleAt < this.opts.cooldownMs) {
      return null
    }
    this.lastSampleAt = now
    return Math.round(gap)
  }

  /** Stop sampling permanently (e.g. the `sample` binary is missing). */
  disable(): void {
    this.disabled = true
  }
}

/**
 * Main-thread side: spawns the worker, forwards heartbeats (called from the
 * event-loop monitor tick — no extra main-thread timer), logs the reports.
 */
export class StallWatchdog {
  private worker: Worker | null = null
  private disposed = false

  constructor(private readonly opts: StallWatchdogConfig) {}

  start(): void {
    if (this.disposed || this.worker || !this.opts.enabled) return
    // Compiled Bun binaries need string paths; dev mode needs URL resolution.
    const workerPath = import.meta.url.includes('$bunfs')
      ? './stallWatchdogWorker.ts'
      : new URL('./stallWatchdogWorker.ts', import.meta.url).href
    const worker = new Worker(workerPath, { type: 'module' })
    worker.onmessage = (event) =>
      this.handleMessage(event.data as StallWatchdogWorkerResponse)
    worker.onerror = (event) => {
      logger.warn('stall_watchdog_worker_error', {
        message: event instanceof ErrorEvent ? event.message : 'worker error',
      })
    }
    const init: StallWatchdogWorkerRequest = {
      kind: 'init',
      pid: this.opts.pid,
      sampleDir: this.opts.sampleDir,
      thresholdMs: this.opts.thresholdMs,
      sampleSeconds: this.opts.sampleSeconds,
      cooldownMs: this.opts.cooldownMs,
      maxSamples: this.opts.maxSamples,
      checkIntervalMs: this.opts.checkIntervalMs,
    }
    worker.postMessage(init)
    this.worker = worker
    logger.info('stall_watchdog_started', {
      thresholdMs: this.opts.thresholdMs,
      sampleDir: this.opts.sampleDir,
    })
  }

  /** Heartbeat — called every event-loop monitor tick. */
  beat(): void {
    this.worker?.postMessage({ kind: 'beat' } satisfies StallWatchdogWorkerRequest)
  }

  dispose(): void {
    this.disposed = true
    const worker = this.worker
    this.worker = null
    if (!worker) return
    // No terminate(): it segfaults compiled Bun binaries (BUN-118B). Ask the
    // worker to exit cooperatively like devinSyncWorkerClient does.
    try {
      worker.postMessage({ kind: 'shutdown' } satisfies StallWatchdogWorkerRequest)
    } catch {
      // Already gone.
    }
    worker.onmessage = null
    worker.onerror = null
  }

  private handleMessage(response: StallWatchdogWorkerResponse): void {
    if (response.kind === 'sampled') {
      logger.warn('stall_watchdog_sampled', {
        path: response.path,
        gapMs: response.gapMs,
        sampleMs: response.sampleMs,
      })
    } else if (response.kind === 'sample_failed') {
      logger.warn('stall_watchdog_sample_failed', {
        gapMs: response.gapMs,
        error: response.error,
      })
    } else {
      logger.warn('stall_watchdog_disabled', { reason: response.reason })
    }
  }
}
