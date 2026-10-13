// stallGapTracker.ts - Heartbeat-gap bookkeeping for the stall watchdog.
//
// Deliberately free of imports and side effects: stallWatchdogWorker.ts (the
// diagnostic observer) loads this on its own thread and must not pull the
// logger or other runtime initialization into the worker.
//
// Beats carry the main thread's send timestamp, not the worker's receipt
// time: a starved worker that wakes to a queue of stale beats would
// otherwise mark itself healthy mid-stall. With sent timestamps the gap is
// "how long since the main thread was last observed alive", which queued
// delivery cannot mask — the newest beat in the queue still records when
// the sender last ran.
export class StallGapTracker {
  private lastAliveAt: number
  private lastSampleAt = Number.NEGATIVE_INFINITY
  private disabled = false

  constructor(
    private readonly opts: {
      thresholdMs: number
      cooldownMs: number
      now?: () => number
    }
  ) {
    this.lastAliveAt = this.now()
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  /** Records the main thread's send timestamp (Date.now() at send time). */
  beat(sentAt: number): void {
    this.lastAliveAt = Math.max(this.lastAliveAt, sentAt)
  }

  /**
   * Returns the heartbeat gap in ms when a sample should be taken: the gap
   * means the main thread is stalled *right now*. Cooldown starts at trigger
   * time, so a failing or ignored `sample` cannot spam; null otherwise.
   */
  check(): number | null {
    if (this.disabled) return null
    const now = this.now()
    const gap = now - this.lastAliveAt
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
