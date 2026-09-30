// Per-connection sliding-window limit on session kills.
//
// The kill shortcut auto-selects the next session, so holding or mashing it
// walks down the list killing everything. A small burst allowance keeps
// deliberate cleanup fast while stopping a runaway cascade.

export const KILL_BURST_LIMIT = 3
export const KILL_BURST_WINDOW_MS = 5_000

export class KillRateLimiter {
  private readonly history = new Map<string, number[]>()

  constructor(
    private readonly limit = KILL_BURST_LIMIT,
    private readonly windowMs = KILL_BURST_WINDOW_MS,
  ) {}

  /** Records the attempt and returns false when it exceeds the limit. */
  tryAcquire(connectionId: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs
    const recent = (this.history.get(connectionId) ?? []).filter((ts) => ts > cutoff)
    if (recent.length >= this.limit) {
      this.history.set(connectionId, recent)
      return false
    }
    recent.push(now)
    this.history.set(connectionId, recent)
    return true
  }

  forget(connectionId: string): void {
    this.history.delete(connectionId)
  }
}
