import { describe, expect, test } from 'bun:test'
import { PtyTerminalProxy as TerminalProxy } from '../../terminal'

function createSpawnHarness() {
  const spawnCalls: Array<{
    args: string[]
    options: Parameters<typeof Bun.spawn>[1]
  }> = []
  const spawnSyncCalls: string[][] = []
  const writes: string[] = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let closed = false
  let killed = false
  let exitResolver: (() => void) | null = null
  let dataHandler: ((terminal: Bun.Terminal, data: Uint8Array) => void) | null =
    null
  let exitHandler: ((terminal: Bun.Terminal, code: number, signal: string | null) => void) | null =
    null

  const exited = new Promise<void>((resolve) => {
    exitResolver = resolve
  })

  const terminal = {
    write: (data: string) => {
      writes.push(data)
    },
    resize: (cols: number, rows: number) => {
      resizes.push({ cols, rows })
    },
    close: () => {
      closed = true
    },
  }

  const spawn = (args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    spawnCalls.push({ args, options })
    const termOptions = (options?.terminal ?? {}) as Bun.TerminalOptions
    dataHandler =
      (termOptions.data as unknown as ((terminal: Bun.Terminal, data: Uint8Array) => void)) ??
      null
    exitHandler =
      (termOptions.exit as unknown as ((terminal: Bun.Terminal, code: number, signal: string | null) => void)) ??
      null
    return {
      pid: 4242,
      terminal,
      exited,
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }

  const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
    spawnSyncCalls.push(args)
    const command = args[1]
    if (command === 'list-clients') {
      return {
        exitCode: 0,
        stdout: Buffer.from('/dev/pts/9 4242\n'),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }

  return {
    spawn,
    spawnSync,
    spawnCalls,
    spawnSyncCalls,
    writes,
    resizes,
    terminal,
    exited,
    resolveExit: () => exitResolver?.(),
    wasClosed: () => closed,
    wasKilled: () => killed,
    emitData: (text: string) => {
      if (!dataHandler) return
      const payload = new TextEncoder().encode(text)
      dataHandler(terminal as unknown as Bun.Terminal, payload)
    },
    emitExit: () => {
      exitHandler?.(terminal as unknown as Bun.Terminal, 0, null)
    },
  }
}

describe('TerminalProxy', () => {
  test('starts tmux client and discovers tty', async () => {
    const harness = createSpawnHarness()
    const received: string[] = []

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: (data) => received.push(data),
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    expect(harness.spawnSyncCalls).toContainEqual([
      'tmux',
      'new-session',
      '-d',
      '-t',
      'agentboard',
      '-s',
      'agentboard-ws-abc',
    ])
    expect(harness.spawnCalls[0]?.args).toEqual([
      'tmux',
      'attach',
      '-t',
      'agentboard-ws-abc',
    ])

    harness.emitData('hello')
    expect(received).toEqual(['hello'])
    expect(proxy.getClientTty()).toBe('/dev/pts/9')
    expect(proxy.isReady()).toBe(true)
  })

  test('switchTo issues switch and refresh commands', async () => {
    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    let readyCalls = 0
    await proxy.switchTo('external:@2', () => {
      readyCalls += 1
    })

    expect(readyCalls).toBe(1)
    expect(harness.spawnSyncCalls).toContainEqual([
      'tmux',
      'switch-client',
      '-c',
      '/dev/pts/9',
      '-t',
      'external:@2',
    ])
    expect(harness.spawnSyncCalls).toContainEqual([
      'tmux',
      'refresh-client',
      '-t',
      '/dev/pts/9',
    ])
    expect(proxy.getCurrentWindow()).toBe('@2')
  })

  test('switchTo rewrites base-session targets to grouped session targets', async () => {
    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@2')

    expect(harness.spawnSyncCalls).toContainEqual([
      'tmux',
      'switch-client',
      '-c',
      '/dev/pts/9',
      '-t',
      'agentboard-ws-abc:@2',
    ])
    expect(proxy.getCurrentWindow()).toBe('@2')
  })

  test('copies mouse setting from base session to grouped session', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = args[1]
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from('/dev/pts/9 4242\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command === 'show-option' && args.includes('mouse')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('on\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'mouse-test',
      sessionName: 'agentboard-ws-mouse-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    // Should read mouse from the base session
    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'show-option',
      '-t',
      'agentboard',
      '-v',
      'mouse',
    ])

    // Should set mouse on the grouped session
    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'set-option',
      '-t',
      'agentboard-ws-mouse-test',
      'mouse',
      'on',
    ])
  })

  test('copies mouse=off setting from base session to grouped session', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = args[1]
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from('/dev/pts/9 4242\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command === 'show-option' && args.includes('mouse')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('off\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'mouse-off-test',
      sessionName: 'agentboard-ws-mouse-off-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'set-option',
      '-t',
      'agentboard-ws-mouse-off-test',
      'mouse',
      'off',
    ])
  })

  test('does not set grouped mouse option when base mouse setting is empty', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = args[1]
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from('/dev/pts/9 4242\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command === 'show-option' && args.includes('mouse')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'mouse-empty-test',
      sessionName: 'agentboard-ws-mouse-empty-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    expect(
      spawnSyncCalls.some(
        (call) => call[1] === 'set-option' && call.includes('mouse')
      )
    ).toBe(false)
  })

  test('continues when reading base mouse setting fails', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = args[1]
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from('/dev/pts/9 4242\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command === 'show-option' && args.includes('mouse')) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('unknown option'),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'mouse-fail-test',
      sessionName: 'agentboard-ws-mouse-fail-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    expect(
      spawnSyncCalls.some(
        (call) => call[1] === 'set-option' && call.includes('mouse')
      )
    ).toBe(false)
    expect(proxy.isReady()).toBe(true)
  })

  test('continues when applying grouped mouse setting fails', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = args[1]
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from('/dev/pts/9 4242\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (command === 'show-option' && args.includes('mouse')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('on\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (
        command === 'set-option' &&
        args.includes('agentboard-ws-mouse-apply-fail-test') &&
        args.includes('mouse')
      ) {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('set failed'),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'mouse-apply-fail-test',
      sessionName: 'agentboard-ws-mouse-apply-fail-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'show-option',
      '-t',
      'agentboard',
      '-v',
      'mouse',
    ])
    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'set-option',
      '-t',
      'agentboard-ws-mouse-apply-fail-test',
      'mouse',
      'on',
    ])
    expect(proxy.isReady()).toBe(true)
  })

  test('disposes tmux client and session', async () => {
    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    proxy.write('ls')
    proxy.resize(120, 40)
    await proxy.dispose()

    expect(harness.writes).toEqual(['ls'])
    expect(harness.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(harness.wasClosed()).toBe(true)
    expect(harness.wasKilled()).toBe(true)
    expect(harness.spawnSyncCalls).toContainEqual([
      'tmux',
      'kill-session',
      '-t',
      'agentboard-ws-abc',
    ])
  })
})
