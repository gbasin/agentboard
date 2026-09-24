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

export function logSlowSyncSpawn(
  command: string,
  durationMs: number,
  timeoutMs?: number,
  isMainThread: boolean = Bun.isMainThread
): void {
  if (durationMs < SLOW_SYNC_SPAWN_MS) return
  // Blocking only matters on the main thread; worker scans (logMatchWorker's
  // rg) routinely exceed the threshold and would warn every cycle.
  if (isMainThread) {
    logger.warn('sync_spawn_slow', { command, durationMs, timeoutMs })
  } else {
    logger.debug('sync_spawn_slow', { command, durationMs, timeoutMs, worker: true })
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
  const result = Bun.spawnSync(command, options)
  logSlowSyncSpawn(
    describeSpawnCommand(command),
    Math.round(performance.now() - startedAt),
    options?.timeout
  )
  return result
}
