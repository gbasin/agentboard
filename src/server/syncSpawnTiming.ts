// Timing instrumentation for synchronous subprocess calls.
//
// Bun.spawnSync blocks the event loop for the entire call. When the tmux
// server or the disk is stalled (memory pressure, swap thrash), each call can
// sit for seconds and they chain into multi-minute freezes. Logging every
// call over the threshold lets us see which command was actually slow during
// a freeze instead of guessing from side effects (missed pongs, reconnects).

import { logger } from './logger'
import { sanitizedTmuxEnv } from './tmuxEnv'

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

// A call this slow is the freeze, not noise. It bypasses suppression so the
// line lands next to the event_loop_lag it caused, instead of hiding inside an
// aggregate that only flushes on the next slow call after the window closes.
// (First live data point: a 21.7s switch-client 20s after a 273ms one was
// swallowed, leaving a 20.8s lag with no named cause.)
export const SLOW_SYNC_SPAWN_OUTLIER_MS = 1000

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
  context: SlowSyncSpawnContext = {}
): void {
  logSlowSpawn('sync_spawn_slow', command, durationMs, timeoutMs, context)
}

// Async spawns (Bun.spawn) do not hold the event loop, but a slow one still
// means tmux or ps is stalled, and the caller is waiting on it. Same threshold,
// rate limit and outlier rule as the sync log, under its own event name so a
// freeze investigation can tell blocking calls from non-blocking ones.
export function logSlowAsyncSpawn(
  command: string,
  durationMs: number,
  timeoutMs?: number,
  context: SlowSyncSpawnContext = {}
): void {
  logSlowSpawn('async_spawn_slow', command, durationMs, timeoutMs, context)
}

function logSlowSpawn(
  event: 'sync_spawn_slow' | 'async_spawn_slow',
  command: string,
  durationMs: number,
  timeoutMs: number | undefined,
  { isMainThread = Bun.isMainThread, now = performance.now() }: SlowSyncSpawnContext
): void {
  if (durationMs < SLOW_SYNC_SPAWN_MS) return
  // Blocking only matters on the main thread; worker scans (logMatchWorker's
  // rg) routinely exceed the threshold and would warn every cycle.
  if (!isMainThread) {
    logger.debug(event, { command, durationMs, timeoutMs, worker: true })
    return
  }

  const key = `${event}\0${command}`
  const window = slowWindows.get(key)
  if (!window || (window.count === 0 && now - window.windowStart >= SLOW_SYNC_SPAWN_AGGREGATE_MS)) {
    logger.warn(event, { command, durationMs, timeoutMs })
    slowWindows.set(key, { windowStart: now, count: 0, maxMs: 0, sumMs: 0 })
    return
  }

  window.count += 1
  window.maxMs = Math.max(window.maxMs, durationMs)
  window.sumMs += durationMs
  if (durationMs >= SLOW_SYNC_SPAWN_OUTLIER_MS) {
    logger.warn(event, { command, durationMs, timeoutMs, outlier: true })
  }
  const windowMs = now - window.windowStart
  if (windowMs >= SLOW_SYNC_SPAWN_AGGREGATE_MS) {
    logger.warn(`${event}_aggregate`, {
      command,
      count: window.count,
      maxMs: window.maxMs,
      sumMs: window.sumMs,
      windowMs: Math.round(windowMs),
      timeoutMs,
    })
    slowWindows.set(key, { windowStart: now, count: 0, maxMs: 0, sumMs: 0 })
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
    // Explicit env: omitted entirely, Bun reuses the environment captured at
    // process start — mutations like tmuxIsolation's `delete process.env.TMUX`
    // never reach the child (and never reach Workers at all). An explicit
    // `env` is read fresh at call time. Callers may still override.
    return Bun.spawnSync(command, {
      ...options,
      env: options?.env ?? sanitizedTmuxEnv(),
    })
  } finally {
    // Record timing even when spawnSync throws (e.g. ENOENT after a stall).
    logSlowSyncSpawn(
      describeSpawnCommand(command),
      Math.round(performance.now() - startedAt),
      options?.timeout
    )
  }
}

export interface TimedSpawnResult {
  /** null when the process died from a signal (including the timeout kill). */
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/**
 * Non-blocking counterpart of timedSpawnSync: Bun.spawn waits off the JS
 * thread, so WebSocket and terminal traffic keep flowing while ps or tmux is
 * slow. Collects stdout/stderr as text and logs async_spawn_slow past the
 * threshold. Throws only when the spawn itself fails (e.g. ENOENT).
 */
export async function timedSpawnAsync(
  command: string[],
  options: { timeout?: number; env?: Record<string, string | undefined> } = {}
): Promise<TimedSpawnResult> {
  const startedAt = performance.now()
  try {
    const proc = Bun.spawn(command, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: options.timeout,
      // Explicit: without env, Bun resolves the program on the PATH from
      // process start rather than the current process.env. Sanitized for the
      // same reason as the sync path — and so Workers (whose process.env is
      // the stale start-up copy) still get the post-isolation tmux env.
      env: options.env ?? sanitizedTmuxEnv(),
    })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { exitCode: proc.exitCode, signalCode: proc.signalCode, stdout, stderr }
  } finally {
    logSlowAsyncSpawn(
      describeSpawnCommand(command),
      Math.round(performance.now() - startedAt),
      options.timeout
    )
  }
}
