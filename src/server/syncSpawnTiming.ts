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

export function logSlowSyncSpawn(
  command: string,
  durationMs: number,
  timeoutMs?: number
): void {
  if (durationMs < SLOW_SYNC_SPAWN_MS) return
  logger.warn('sync_spawn_slow', { command, durationMs, timeoutMs })
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
    // The tmux subcommand is enough to identify the call site class; a longer
    // argv preview keeps format strings readable without dumping them whole.
    command.slice(0, 4).join(' '),
    Math.round(performance.now() - startedAt),
    options?.timeout
  )
  return result
}
