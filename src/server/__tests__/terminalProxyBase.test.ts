import { describe, expect, test } from 'bun:test'
import { TerminalProxyBase } from '../terminal/TerminalProxyBase'
import type { SpawnSyncFn, TerminalProxyOptions } from '../terminal/types'

const okSpawnSync: SpawnSyncFn = () =>
  ({
    exitCode: 0,
    stdout: Buffer.from('ok'),
    stderr: Buffer.from(''),
  }) as ReturnType<typeof Bun.spawnSync>

const errorSpawnSync: SpawnSyncFn = () =>
  ({
    exitCode: 1,
    stdout: Buffer.from(''),
    stderr: Buffer.from('no tmux'),
  }) as ReturnType<typeof Bun.spawnSync>

function makeOptions(spawnSync: SpawnSyncFn): TerminalProxyOptions {
  return {
    connectionId: 'conn-1',
    sessionName: 'agentboard-ws-conn-1',
    baseSession: 'agentboard',
    onData: () => {},
    spawnSync,
  }
}

class TestProxy extends TerminalProxyBase {
  startCalls = 0
  switchCalls: string[] = []

  protected async doStart(): Promise<void> {
    this.startCalls += 1
  }

  protected async doSwitch(target: string, onReady?: () => void): Promise<boolean> {
    this.switchCalls.push(target)
    this.setCurrentWindow(target)
    onReady?.()
    return true
  }

  write(): void {}
  resize(): void {}
  async dispose(): Promise<void> {}
  getClientTty(): string | null {
    return null
  }
  getMode(): 'pty' | 'pipe-pane' {
    return 'pty'
  }

  runTmuxCommand(args: string[]): string {
    return this.runTmux(args)
  }
}

class FlakyProxy extends TerminalProxyBase {
  attempts = 0

  protected async doStart(): Promise<void> {
    this.attempts += 1
    if (this.attempts === 1) {
      throw new Error('boom')
    }
  }

  protected async doSwitch(): Promise<boolean> {
    return true
  }

  write(): void {}
  resize(): void {}
  async dispose(): Promise<void> {}
  getClientTty(): string | null {
    return null
  }
  getMode(): 'pty' | 'pipe-pane' {
    return 'pty'
  }
}

describe('TerminalProxyBase', () => {
  test('start is idempotent', async () => {
    const proxy = new TestProxy(makeOptions(okSpawnSync))
    await proxy.start()
    await proxy.start()
    expect(proxy.startCalls).toBe(1)
  })

  test('start retries after failure', async () => {
    const proxy = new FlakyProxy(makeOptions(okSpawnSync))
    await expect(proxy.start()).rejects.toThrow('boom')
    await proxy.start()
    expect(proxy.attempts).toBe(2)
  })

  test('switchTo batches calls to the latest target', async () => {
    const proxy = new TestProxy(makeOptions(okSpawnSync))
    const first = proxy.switchTo('agentboard:1.0')
    const second = proxy.switchTo('agentboard:2.1')
    const results = await Promise.all([first, second])
    expect(results).toEqual([true, true])
    expect(proxy.switchCalls).toEqual(['agentboard:2.1'])
    expect(proxy.getCurrentWindow()).toBe('2')
  })

  test('runTmux returns stdout and throws on errors', () => {
    const okProxy = new TestProxy(makeOptions(okSpawnSync))
    expect(okProxy.runTmuxCommand(['list-windows'])).toBe('ok')

    const errorProxy = new TestProxy(makeOptions(errorSpawnSync))
    expect(() => errorProxy.runTmuxCommand(['list-windows'])).toThrow('no tmux')
  })
})
