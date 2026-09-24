// Timing instrumentation for synchronous subprocess calls.
//
// Bun.spawnSync blocks the event loop for the entire call. When the tmux
// server or the disk is stalled (memory pressure, swap thrash), each call can
// sit for seconds and they chain into multi-minute freezes. Logging every
// call over the threshold lets us see which command was actually slow during
// a freeze instead of guessing from side effects (missed pongs, reconnects).

import { logger } from './logger'

// Slower than this produces user-visible input lag while it runs.
export const SLOW_SYNC_SPAWN_MS = 250

// Only log tokens that name the call site. Free-form arguments (rg patterns
// built from user prompts, tmux targets, file paths) must never reach the log.
const SAFE_TOKEN = /^-{0,2}[A-Za-z0-9_.=-]{1,32}$/

export function describeSpawnCommand(command: readonly string[]): string {
  const [program, first, second] = command
  const parts = [program ?? 'unknown']
  if (first !== undefined && SAFE_TOKEN.test(first)) {
    parts.push(first)
    // `tmux -u list-panes`: a leading tmux flag hides the subcommand.
    const isTmux = program === 'tmux' || program?.endsWith('/tmux') === true
    if (isTmux && first.startsWith('-') && second !== undefined && SAFE_TOKEN.test(second)) {
      parts.push(second)
    }
  }
  return parts.join(' ')
}

// Rate limit per redacted command. Under chronic tmux slowness every poll
// call is slow; one warn per call is thousands of lines an hour, each a sync
// disk write on the main thread during the very stall being diagnosed. The
// first slow call per command warns immediately; later ones are counted and
// reported as one aggregate line per command at most every window. A pending
// aggregate is emitted by the next slow call after its window closes.
export const SLOW_SYNC_SPAWN_AGGREGATE_MS = 60_000

interface SlowSpawnWindow {
  windowStart: number
  count: number
  maxMs: number
  sumMs: number
}

const slowWindows = new Map<string, SlowSpawnWindow>()

export function resetSlowSyncSpawnState(): void {
  slowWindows.clear()
}

export interface SlowSyncSpawnContext {
  isMainThread?: boolean
  /** Monotonic ms clock; injectable for tests. */
  now?: number
}

export function logSlowSyncSpawn(
  command: string,
  durationMs: number,
  timeoutMs?: number,
  { isMainThread = Bun.isMainThread, now = performance.now() }: SlowSyncSpawnContext = {}
): void {
  if (durationMs < SLOW_SYNC_SPAWN_MS) return
  // Blocking only matters on the main thread; worker scans (logMatchWorker's
  // rg) routinely exceed the threshold and would warn every cycle.
  if (!isMainThread) {
    logger.debug('sync_spawn_slow', { command, durationMs, timeoutMs, worker: true })
    return
  }

  const window = slowWindows.get(command)
  if (!window || (window.count === 0 && now - window.windowStart >= SLOW_SYNC_SPAWN_AGGREGATE_MS)) {
    logger.warn('sync_spawn_slow', { command, durationMs, timeoutMs })
    slowWindows.set(command, { windowStart: now, count: 0, maxMs: 0, sumMs: 0 })
    return
  }

  window.count += 1
  window.maxMs = Math.max(window.maxMs, durationMs)
  window.sumMs += durationMs
  const windowMs = now - window.windowStart
  if (windowMs >= SLOW_SYNC_SPAWN_AGGREGATE_MS) {
    logger.warn('sync_spawn_slow_aggregate', {
      command,
      count: window.count,
      maxMs: window.maxMs,
      sumMs: window.sumMs,
      windowMs: Math.round(windowMs),
      timeoutMs,
    })
    slowWindows.set(command, { windowStart: now, count: 0, maxMs: 0, sumMs: 0 })
  }
}

export function timedSpawnSync<
  const In extends Bun.SpawnOptions.Writable = 'ignore',
  const Out extends Bun.SpawnOptions.Readable = 'pipe',
  const Err extends Bun.SpawnOptions.Readable = 'pipe',
>(
  command: string[],
  options?: Bun.SpawnOptions.SpawnSyncOptions<In, Out, Err>
): Bun.SyncSubprocess<Out, Err> {
  const startedAt = performance.now()
  try {
    return Bun.spawnSync(command, options)
  } finally {
    // Record timing even when spawnSync throws (e.g. ENOENT after a stall).
    logSlowSyncSpawn(
      describeSpawnCommand(command),
      Math.round(performance.now() - startedAt),
      options?.timeout
    )
  }
}
