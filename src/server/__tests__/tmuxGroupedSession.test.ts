// Regression guard for the 0.23.0 stall: grouped-session creation runs on
// every WebSocket connection and must stay a single tmux call. Any process
// listing, signal or extra spawn on this path fails these tests.
import { afterEach, describe, expect, test } from 'bun:test'
import { createGroupedSession } from '../tmuxGroupedSession'
import { ThrowawayShellReaper } from '../throwawayShellReaper'

const bunAny = Bun as typeof Bun & {
  spawn: typeof Bun.spawn
  spawnSync: typeof Bun.spawnSync
}
const originalSpawn = Bun.spawn
const originalSpawnSync = Bun.spawnSync
const originalKill = process.kill

afterEach(() => {
  bunAny.spawn = originalSpawn
  bunAny.spawnSync = originalSpawnSync
  process.kill = originalKill
})

describe('createGroupedSession', () => {
  test('runs exactly one new-session and nothing else, even with the reaper armed', () => {
    const directSpawns: string[][] = []
    bunAny.spawn = ((command: string[]) => {
      directSpawns.push(command)
      throw new Error('unexpected Bun.spawn on the creation path')
    }) as unknown as typeof Bun.spawn
    bunAny.spawnSync = ((command: string[]) => {
      directSpawns.push(command)
      throw new Error('unexpected Bun.spawnSync on the creation path')
    }) as unknown as typeof Bun.spawnSync
    const signals: number[] = []
    process.kill = ((pid: number) => {
      signals.push(pid)
      return true
    }) as typeof process.kill

    const reaperSpawns: string[][] = []
    const timers: number[] = []
    const reaper = new ThrowawayShellReaper({
      getServerPid: () => 500,
      platform: 'darwin',
      runCommand: async (argv) => {
        reaperSpawns.push(argv)
        return { exitCode: 1, stdout: '' }
      },
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return {}
      },
      clearTimer: () => {},
    })

    const tmuxCalls: string[][] = []
    for (let i = 0; i < 200; i += 1) {
      createGroupedSession(
        {
          runTmux: (args) => {
            tmuxCalls.push(args)
            return ''
          },
          onCreated: () => reaper.noteGroupedSessionCreated(),
        },
        '=agentboard',
        `agentboard-ws-${i}`
      )
    }

    expect(tmuxCalls).toHaveLength(200)
    expect(tmuxCalls[0]).toEqual(['new-session', '-d', '-t', '=agentboard', '-s', 'agentboard-ws-0'])
    expect(tmuxCalls.every((args) => args[0] === 'new-session')).toBe(true)
    expect(directSpawns).toEqual([])
    expect(signals).toEqual([])
    expect(reaperSpawns).toEqual([])
    // Each creation only re-arms one timer.
    expect(timers).toHaveLength(200)
  })

  test('propagates new-session failure without arming the reaper', () => {
    let armed = 0
    expect(() =>
      createGroupedSession(
        {
          runTmux: () => {
            throw new Error('duplicate session')
          },
          onCreated: () => {
            armed += 1
          },
        },
        '=agentboard',
        'agentboard-ws-x'
      )
    ).toThrow('duplicate session')
    expect(armed).toBe(0)
  })
})
