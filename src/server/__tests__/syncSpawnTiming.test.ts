// syncSpawnTiming.test.ts - slow-spawn logging redacts argv and skips workers
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { logger } from '../logger'
import {
  SLOW_SYNC_SPAWN_AGGREGATE_MS,
  SLOW_SYNC_SPAWN_MS,
  describeSpawnCommand,
  logSlowAsyncSpawn,
  logSlowSyncSpawn,
  resetSlowSyncSpawnState,
  timedSpawnAsync,
  timedSpawnSync,
} from '../syncSpawnTiming'

type LogCall = { level: 'warn' | 'debug'; event: string; data?: Record<string, unknown> }

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = Bun.spawnSync
const originalWarn = logger.warn
const originalDebug = logger.debug
let calls: LogCall[] = []

// The logger is process-global and server test files share one bun process:
// background work from earlier files (e.g. a terminal proxy finishing its
// cleanup) can log while an async test here awaits a real spawn. Capture only
// the events this module emits.
const isSpawnEvent = (event: string) => /^(a)?sync_spawn_slow/.test(event)

beforeEach(() => {
  calls = []
  resetSlowSyncSpawnState()
  logger.warn = (event, data) => {
    if (isSpawnEvent(event)) calls.push({ level: 'warn', event, data })
  }
  logger.debug = (event, data) => {
    if (isSpawnEvent(event)) calls.push({ level: 'debug', event, data })
  }
})

afterEach(() => {
  logger.warn = originalWarn
  logger.debug = originalDebug
  bunAny.spawnSync = originalSpawnSync
})

describe('describeSpawnCommand', () => {
  test('rg with a long user-derived pattern logs at most two tokens', () => {
    const pattern = 'please refactor the auth flow\\s+'.repeat(4000)
    const described = describeSpawnCommand(['rg', '-l', '-e', pattern, '--glob', '**/*.jsonl', '/logs'])
    expect(described).toBe('rg -l')
    expect(described.split(' ').length).toBeLessThanOrEqual(2)
  })

  test('drops a free-form first argument', () => {
    expect(describeSpawnCommand(['rg', 'secret prompt text', '/logs'])).toBe('rg')
  })

  test('tmux includes the subcommand after a leading flag', () => {
    expect(describeSpawnCommand(['tmux', '-u', 'list-panes', '-a', '-F', '#{pane_pid}'])).toBe(
      'tmux -u list-panes'
    )
    expect(describeSpawnCommand(['tmux', 'send-keys', '-X', '-t', 'agentboard:@1', 'cancel'])).toBe(
      'tmux send-keys'
    )
  })
})

const main = (now: number) => ({ isMainThread: true, now })

describe('logSlowSyncSpawn', () => {
  test('warns on the main thread at or above the threshold', () => {
    logSlowSyncSpawn('tmux list-panes', SLOW_SYNC_SPAWN_MS - 1, 1000, main(0))
    expect(calls).toHaveLength(0)
    logSlowSyncSpawn('tmux list-panes', SLOW_SYNC_SPAWN_MS, 1000, main(0))
    expect(calls).toEqual([
      {
        level: 'warn',
        event: 'sync_spawn_slow',
        data: { command: 'tmux list-panes', durationMs: SLOW_SYNC_SPAWN_MS, timeoutMs: 1000 },
      },
    ])
  })

  test('suppresses repeats per command and emits one aggregate per window', () => {
    const W = SLOW_SYNC_SPAWN_AGGREGATE_MS
    logSlowSyncSpawn('tmux list-panes', 300, 1000, main(0))
    logSlowSyncSpawn('tmux list-panes', 400, 1000, main(1_000))
    logSlowSyncSpawn('tmux list-panes', 900, 1000, main(2_000))
    // A different command has its own first warning.
    logSlowSyncSpawn('ps -eo', 500, 1000, main(2_500))
    expect(calls.map((c) => [c.event, c.data?.command])).toEqual([
      ['sync_spawn_slow', 'tmux list-panes'],
      ['sync_spawn_slow', 'ps -eo'],
    ])

    // The first slow call after the window closes flushes the aggregate,
    // including itself.
    logSlowSyncSpawn('tmux list-panes', 350, 1000, main(W))
    expect(calls.at(-1)).toEqual({
      level: 'warn',
      event: 'sync_spawn_slow_aggregate',
      data: {
        command: 'tmux list-panes',
        count: 3,
        maxMs: 900,
        sumMs: 1650,
        windowMs: W,
        timeoutMs: 1000,
      },
    })

    // Next window: suppressed again until it closes.
    logSlowSyncSpawn('tmux list-panes', 300, 1000, main(W + 10))
    expect(calls).toHaveLength(3)
  })

  test('an outlier bypasses suppression and still counts in the aggregate', () => {
    const W = SLOW_SYNC_SPAWN_AGGREGATE_MS
    logSlowSyncSpawn('tmux switch-client', 273, 3000, main(0))
    // 20s later, inside the window: a 21.7s call must not be swallowed.
    logSlowSyncSpawn('tmux switch-client', 21_746, 3000, main(20_000))
    expect(calls.at(-1)).toEqual({
      level: 'warn',
      event: 'sync_spawn_slow',
      data: { command: 'tmux switch-client', durationMs: 21_746, timeoutMs: 3000, outlier: true },
    })
    // Sub-outlier repeats stay suppressed.
    logSlowSyncSpawn('tmux switch-client', 999, 3000, main(21_000))
    expect(calls).toHaveLength(2)
    // The aggregate still includes the outlier.
    logSlowSyncSpawn('tmux switch-client', 300, 3000, main(W))
    expect(calls.at(-1)?.data).toMatchObject({ count: 3, maxMs: 21_746, sumMs: 23_045 })
  })

  test('a quiet window resets to an immediate warning', () => {
    logSlowSyncSpawn('tmux list-panes', 300, 1000, main(0))
    logSlowSyncSpawn('tmux list-panes', 300, 1000, main(SLOW_SYNC_SPAWN_AGGREGATE_MS + 1))
    expect(calls.map((c) => c.event)).toEqual(['sync_spawn_slow', 'sync_spawn_slow'])
  })

  test('worker-thread calls log at debug, never warn', () => {
    logSlowSyncSpawn('rg -l', 460, 10000, { isMainThread: false, now: 0 })
    expect(calls.map((c) => c.level)).toEqual(['debug'])
  })
})

describe('timedSpawnSync', () => {
  test('logs the redacted command for a slow spawn', () => {
    const pattern = 'x'.repeat(121_000)
    bunAny.spawnSync = (() => {
      const until = performance.now() + SLOW_SYNC_SPAWN_MS + 5
      while (performance.now() < until) {
        // simulate a slow blocking call
      }
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }) as unknown as typeof Bun.spawnSync

    timedSpawnSync(['rg', '-l', '-e', pattern, '/logs'])

    expect(calls).toHaveLength(1)
    expect(calls[0]?.data?.command).toBe('rg -l')
    expect(JSON.stringify(calls)).not.toContain('xxxx')
  })

  test('records timing when spawnSync throws', () => {
    bunAny.spawnSync = (() => {
      const until = performance.now() + SLOW_SYNC_SPAWN_MS + 5
      while (performance.now() < until) {
        // stall, then fail
      }
      throw new Error('spawn failed')
    }) as unknown as typeof Bun.spawnSync

    expect(() => timedSpawnSync(['tmux', 'list-panes', '-a'])).toThrow('spawn failed')
    expect(calls.map((c) => [c.event, c.data?.command])).toEqual([
      ['sync_spawn_slow', 'tmux list-panes'],
    ])
  })
})

describe('logSlowAsyncSpawn', () => {
  test('uses its own event name and its own rate-limit window', () => {
    logSlowSyncSpawn('tmux list-panes', 300, 1000, main(0))
    // Same command, different kind: not suppressed by the sync window.
    logSlowAsyncSpawn('tmux list-panes', 300, 1000, main(10))
    logSlowAsyncSpawn('tmux list-panes', 400, 1000, main(20))
    expect(calls.map((c) => c.event)).toEqual(['sync_spawn_slow', 'async_spawn_slow'])
    logSlowAsyncSpawn('tmux list-panes', 300, 1000, main(SLOW_SYNC_SPAWN_AGGREGATE_MS + 10))
    expect(calls.at(-1)).toMatchObject({
      event: 'async_spawn_slow_aggregate',
      data: { command: 'tmux list-panes', count: 2, maxMs: 400, sumMs: 700 },
    })
  })
})

describe('timedSpawnAsync', () => {
  test('returns output and logs a slow call with the redacted command', async () => {
    const delay = (SLOW_SYNC_SPAWN_MS + 50) / 1000
    const result = await timedSpawnAsync(['sh', '-c', `sleep ${delay}; printf ok`], {
      timeout: 5000,
    })
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok', stderr: '' })
    expect(calls.map((c) => [c.event, c.data?.command, c.data?.timeoutMs])).toEqual([
      ['async_spawn_slow', 'sh -c', 5000],
    ])
  })

  test('a fast call logs nothing', async () => {
    const result = await timedSpawnAsync(['sh', '-c', 'printf err >&2; exit 3'])
    expect(result).toMatchObject({ exitCode: 3, stdout: '', stderr: 'err' })
    expect(calls).toHaveLength(0)
  })
})
