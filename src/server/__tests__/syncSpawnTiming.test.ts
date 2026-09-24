// syncSpawnTiming.test.ts - slow-spawn logging redacts argv and skips workers
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { logger } from '../logger'
import {
  SLOW_SYNC_SPAWN_AGGREGATE_MS,
  SLOW_SYNC_SPAWN_MS,
  describeSpawnCommand,
  logSlowSyncSpawn,
  resetSlowSyncSpawnState,
  timedSpawnSync,
} from '../syncSpawnTiming'

type LogCall = { level: 'warn' | 'debug'; event: string; data?: Record<string, unknown> }

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = Bun.spawnSync
const originalWarn = logger.warn
const originalDebug = logger.debug
let calls: LogCall[] = []

beforeEach(() => {
  calls = []
  resetSlowSyncSpawnState()
  logger.warn = (event, data) => calls.push({ level: 'warn', event, data })
  logger.debug = (event, data) => calls.push({ level: 'debug', event, data })
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
