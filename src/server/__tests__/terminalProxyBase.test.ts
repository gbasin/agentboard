import { describe, expect, test } from 'bun:test'
import { TerminalProxyBase } from '../terminal/TerminalProxyBase'
import { TmuxTimeoutError } from '../tmuxTimeout'
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

const timeoutSpawnSync: SpawnSyncFn = (_args, options) =>
  ({
    exitCode: null,
    signalCode: 'SIGTERM',
    stdout: Buffer.from(''),
    stderr: Buffer.from(''),
    timeoutSeen: options?.timeout,
  }) as unknown as ReturnType<typeof Bun.spawnSync>

function makeOptions(spawnSync: SpawnSyncFn): TerminalProxyOptions {
  return {
    connectionId: 'conn-1',
    sessionName: 'agentboard-ws-conn-1',
    baseSession: 'agentboard',
    onData: () => {},
    spawnSync,
    commandTimeoutMs: 1234,
    mutationTimeoutMs: 5678,
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
  paste(): void {}
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

  deliverPaste(target: string, data: string): void {
    this.deliverPasteViaTmux(target, data)
  }

  nextBufferName(): string {
    return this.nextPasteBufferName()
  }

  normalize(data: string): string {
    return this.normalizePasteData(data)
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
  paste(): void {}
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

  test('runTmux applies a timeout and throws TmuxTimeoutError when tmux hangs', () => {
    const proxy = new TestProxy(makeOptions(timeoutSpawnSync))
    expect(() => proxy.runTmuxCommand(['list-windows'])).toThrow(TmuxTimeoutError)
    expect(() => proxy.runTmuxCommand(['list-windows'])).toThrow(
      'tmux list-windows timed out after 1234ms'
    )
  })

  test('deliverPasteViaTmux stages via load-buffer stdin then paste-buffer -p', () => {
    const calls: Array<{ args: string[]; options?: { stdin?: Buffer } }> = []
    const recordingSpawnSync: SpawnSyncFn = (args, options) => {
      calls.push({ args, options: options as { stdin?: Buffer } })
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    const proxy = new TestProxy(makeOptions(recordingSpawnSync))
    proxy.deliverPaste('agentboard:@1', 'line1\r\nline2\rline3\nline4')

    // 1) load-buffer reads the payload from stdin (no argv size limit), with
    //    CRLF/CR collapsed to LF so tmux's LF->CR yields one CR per line.
    expect(calls[0]?.args).toEqual([
      'tmux',
      'load-buffer',
      '-b',
      'agentboard-paste-conn-1-1',
      '-',
    ])
    expect(calls[0]?.options?.stdin?.toString()).toBe('line1\nline2\nline3\nline4')
    // 2) paste-buffer -p brackets only when the real pane requested bracketed
    //    paste; -d cleans up the buffer.
    expect(calls[1]?.args).toEqual([
      'tmux',
      'paste-buffer',
      '-d',
      '-p',
      '-b',
      'agentboard-paste-conn-1-1',
      '-t',
      'agentboard:@1',
    ])
  })

  test('nextPasteBufferName is unique per paste and sanitizes the connection id', () => {
    const proxy = new TestProxy(makeOptions(okSpawnSync))
    expect(proxy.nextBufferName()).toBe('agentboard-paste-conn-1-1')
    expect(proxy.nextBufferName()).toBe('agentboard-paste-conn-1-2')

    const dirty = new TestProxy({ ...makeOptions(okSpawnSync), connectionId: 'a/b c:1' })
    expect(dirty.nextBufferName()).toBe('agentboard-paste-abc1-1')
  })

  test('normalizePasteData collapses CRLF and lone CR to LF', () => {
    const proxy = new TestProxy(makeOptions(okSpawnSync))
    expect(proxy.normalize('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  test('deliverPasteViaTmux does not fall back to a raw write when load-buffer fails', () => {
    let wrote = false
    class GuardProxy extends TestProxy {
      write(): void {
        wrote = true
      }
    }
    const proxy = new GuardProxy(makeOptions(errorSpawnSync))
    // load-buffer throws (errorSpawnSync exit 1); a raw write() fallback would
    // reintroduce the line-by-line auto-submit, so it must NOT happen.
    expect(() => proxy.deliverPaste('t', 'a\nb')).not.toThrow()
    expect(wrote).toBe(false)
  })
})
