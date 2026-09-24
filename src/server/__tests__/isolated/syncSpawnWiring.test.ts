// syncSpawnWiring.test.ts - the main tmux call sites must go through the
// sync-spawn timing helpers. Isolated: mock.module('../../syncSpawnTiming')
// persists for the life of the process.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const timedCalls: string[][] = []
const slowLogCalls: string[] = []

const fakeResult = () => ({
  exitCode: 0,
  signalCode: null,
  stdout: Buffer.from(''),
  stderr: Buffer.from(''),
  success: true,
  pid: 1,
  resourceUsage: undefined,
})

const real = await import('../../syncSpawnTiming')
mock.module('../../syncSpawnTiming', () => ({
  ...real,
  timedSpawnSync: (command: string[]) => {
    timedCalls.push(command)
    return fakeResult()
  },
  logSlowSyncSpawn: (command: string) => {
    slowLogCalls.push(command)
  },
}))

// Guard: a call site that bypasses the helper must not reach a real tmux
// server (agent sessions run inside the live one).
const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = Bun.spawnSync
const directCalls: string[][] = []
bunAny.spawnSync = ((command: string[]) => {
  directCalls.push(command)
  return fakeResult()
}) as unknown as typeof Bun.spawnSync

const { SessionManager } = await import('../../SessionManager')
const { TerminalProxyBase } = await import('../../terminal/TerminalProxyBase')

afterAll(() => {
  bunAny.spawnSync = originalSpawnSync
  mock.restore()
})

beforeEach(() => {
  timedCalls.length = 0
  slowLogCalls.length = 0
  directCalls.length = 0
})

describe('sync spawn timing wiring', () => {
  test('SessionManager.runTmux goes through timedSpawnSync', () => {
    const manager = new SessionManager('wiring-test-session')
    manager.setWindowOption('wiring-test-session:@1', 'automatic-rename', 'off')

    expect(timedCalls.some((c) => c[0] === 'tmux' && c.includes('set-option'))).toBe(true)
    expect(directCalls.filter((c) => c[0] === 'tmux')).toEqual([])
  })

  test('TerminalProxyBase.runTmux records timing via logSlowSyncSpawn', () => {
    const spawnSyncCalls: string[][] = []
    class ProbeProxy extends TerminalProxyBase {
      protected async doStart() {}
      protected async doSwitch() {
        return true
      }
      write() {}
      paste() {}
      resize() {}
      async dispose() {}
      getClientTty() {
        return null
      }
      getMode() {
        return 'pty' as const
      }
      probe(args: string[]) {
        return this.runTmux(args)
      }
    }
    const proxy = new ProbeProxy({
      connectionId: 'wiring',
      sessionName: 'wiring-ws',
      baseSession: 'wiring-base',
      onData: () => {},
      spawnSync: ((command: string[]) => {
        spawnSyncCalls.push(command)
        return fakeResult()
      }) as never,
    })

    proxy.probe(['list-clients', '-t', 'wiring-ws'])

    expect(spawnSyncCalls).toHaveLength(1)
    expect(slowLogCalls).toEqual(['tmux list-clients'])
  })
})
