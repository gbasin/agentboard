import { afterEach, describe, expect, test } from 'bun:test'
import { PipePaneTerminalProxy } from '../terminal/PipePaneTerminalProxy'

const encoder = new TextEncoder()

function createPipeHarness() {
  const spawnCalls: Array<{ args: string[]; options: Parameters<typeof Bun.spawn>[1] }> = []
  const tmuxCalls: string[][] = []
  let listPanesOutput = '1\n'
  let lastController: ReadableStreamDefaultController<Uint8Array> | null = null
  let exitResolver: (() => void) | null = null
  let killed = false

  const spawn = (args: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    spawnCalls.push({ args, options })
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        lastController = controller
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start() {},
    })
    const exited = new Promise<void>((resolve) => {
      exitResolver = resolve
    })

    return {
      stdout,
      stderr,
      exited,
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }

  const spawnSync = (
    args: string[],
    _options?: Parameters<typeof Bun.spawnSync>[1]
  ) => {
    tmuxCalls.push(args)
    if (args[1] === 'list-panes') {
      return {
        exitCode: 0,
        stdout: Buffer.from(listPanesOutput),
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
    tmuxCalls,
    emit: (text: string) => {
      if (!lastController) throw new Error('No stdout controller')
      lastController.enqueue(encoder.encode(text))
    },
    resolveExit: () => {
      exitResolver?.()
    },
    setListPanesOutput: (output: string) => {
      listPanesOutput = output
    },
    wasKilled: () => killed,
  }
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('PipePaneTerminalProxy', () => {
  afterEach(() => {
    // Ensure timers are restored if a test overrides them.
  })

  test('switches target, tails output, writes input, and resizes', async () => {
    const harness = createPipeHarness()
    const received: string[] = []

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-1',
      sessionName: 'agentboard-ws-conn-1',
      baseSession: 'agentboard',
      onData: (data) => {
        received.push(data)
      },
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')

    harness.emit('hello')
    await tick()

    proxy.write('ls\npwd')
    proxy.resize(120, 40)

    expect(received).toEqual(['hello'])
    expect(proxy.getCurrentWindow()).toBe('@1')
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      '-l',
      '--',
      'ls',
    ])
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      'Enter',
    ])
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      '-l',
      '--',
      'pwd',
    ])
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'resize-pane',
      '-t',
      'agentboard:@1',
      '-x',
      '120',
      '-y',
      '40',
    ])

    await proxy.dispose()
  })

  test('marks dead and calls onExit when tail exits', async () => {
    const harness = createPipeHarness()
    let exitCalls = 0

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-2',
      sessionName: 'agentboard-ws-conn-2',
      baseSession: 'agentboard',
      onData: () => {},
      onExit: () => {
        exitCalls += 1
      },
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.switchTo('agentboard:@2')

    harness.resolveExit()
    await tick()

    expect(exitCalls).toBe(1)
    expect(proxy.isReady()).toBe(false)

    await proxy.dispose()
  })

  test('monitor resets when target disappears', async () => {
    const harness = createPipeHarness()
    harness.setListPanesOutput('')

    const originalSetInterval = globalThis.setInterval
    const originalClearInterval = globalThis.clearInterval
    let intervalCallback: (() => void) | null = null

    globalThis.setInterval = ((callback: () => void) => {
      intervalCallback = callback
      return 123 as unknown as ReturnType<typeof setInterval>
    }) as typeof setInterval

    globalThis.clearInterval = (() => {
      intervalCallback = null
    }) as typeof clearInterval

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-3',
      sessionName: 'agentboard-ws-conn-3',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: true,
    })

    try {
      await proxy.switchTo('agentboard:@3')
      expect(proxy.getCurrentWindow()).toBe('@3')

      const callback = intervalCallback as (() => void) | null
      callback?.()

      expect(harness.tmuxCalls).toContainEqual([
        'tmux',
        'list-panes',
        '-t',
        'agentboard:@3',
        '-F',
        '#{pane_id}',
      ])
      expect(proxy.getCurrentWindow()).toBeNull()
      expect(proxy.isReady()).toBe(true)
      expect(harness.wasKilled()).toBe(true)
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
      await proxy.dispose()
    }
  })

  test('propagates failures when tail spawn fails', async () => {
    const harness = createPipeHarness()
    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-4',
      sessionName: 'agentboard-ws-conn-4',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: () => {
        throw new Error('spawn failed')
      },
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await expect(proxy.switchTo('agentboard:@4')).rejects.toMatchObject({
      code: 'ERR_TMUX_SWITCH_FAILED',
    })

    await proxy.dispose()
  })

  test('handles SGR scroll-up sequence with tmux copy-mode instead of send-keys -l', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-1',
      sessionName: 'agentboard-ws-conn-scroll-1',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0 // Clear setup calls

    // Send SGR scroll-up sequence (button 64)
    proxy.write('\x1b[<64;40;12M')

    // Should call copy-mode first
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'copy-mode',
      '-t',
      'agentboard:@1',
    ])

    // Should call scroll-up command
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-up',
    ])

    // Should NOT use send-keys -l (the broken approach)
    const literalSendKeys = harness.tmuxCalls.find(
      (call) => call.includes('-l') && call.includes('\x1b')
    )
    expect(literalSendKeys).toBeUndefined()

    await proxy.dispose()
  })

  test('handles SGR scroll-down sequence with tmux copy-mode', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-2',
      sessionName: 'agentboard-ws-conn-scroll-2',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send SGR scroll-down sequence (button 65)
    proxy.write('\x1b[<65;40;12M')

    // Should call copy-mode
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'copy-mode',
      '-t',
      'agentboard:@1',
    ])

    // Should call scroll-down command
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-down',
    ])

    await proxy.dispose()
  })

  test('regular input still uses send-keys -l', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-3',
      sessionName: 'agentboard-ws-conn-scroll-3',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send regular input
    proxy.write('hello')

    // Should use send-keys -l for regular input
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      '-l',
      '--',
      'hello',
    ])

    // Should NOT call copy-mode for regular input
    const copyModeCall = harness.tmuxCalls.find((call) => call.includes('copy-mode'))
    expect(copyModeCall).toBeUndefined()

    await proxy.dispose()
  })

  test('handles other mouse sequences (non-scroll) with send-keys -l', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-4',
      sessionName: 'agentboard-ws-conn-scroll-4',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send SGR mouse click sequence (button 0 = left click)
    proxy.write('\x1b[<0;40;12M')

    // Should use send-keys -l for non-scroll mouse events
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      '-l',
      '--',
      '\x1b[<0;40;12M',
    ])

    // Should NOT call copy-mode for clicks
    const copyModeCall = harness.tmuxCalls.find((call) => call.includes('copy-mode'))
    expect(copyModeCall).toBeUndefined()

    await proxy.dispose()
  })

  test('handles scroll with modifier keys (shift, ctrl, alt)', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-mod',
      sessionName: 'agentboard-ws-conn-scroll-mod',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')

    // Test Shift+scroll-up (64 + 4 = 68)
    harness.tmuxCalls.length = 0
    proxy.write('\x1b[<68;40;12M')
    expect(harness.tmuxCalls).toContainEqual(['tmux', 'copy-mode', '-t', 'agentboard:@1'])
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-up',
    ])

    // Test Ctrl+scroll-down (65 + 16 = 81)
    harness.tmuxCalls.length = 0
    proxy.write('\x1b[<81;40;12M')
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-down',
    ])

    // Test Alt+Shift+scroll-up (64 + 4 + 8 = 76)
    harness.tmuxCalls.length = 0
    proxy.write('\x1b[<76;40;12M')
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-up',
    ])

    await proxy.dispose()
  })

  test('handles batched scroll sequences in single write', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-batch',
      sessionName: 'agentboard-ws-conn-scroll-batch',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send multiple scroll-up sequences in one write (simulates WS batching)
    proxy.write('\x1b[<64;40;12M\x1b[<64;40;12M\x1b[<64;40;12M')

    // Should only call copy-mode once
    const copyModeCalls = harness.tmuxCalls.filter((call) => call.includes('copy-mode'))
    expect(copyModeCalls.length).toBe(1)

    // Should call scroll-up three times
    const scrollUpCalls = harness.tmuxCalls.filter((call) => call.includes('scroll-up'))
    expect(scrollUpCalls.length).toBe(3)

    await proxy.dispose()
  })

  test('handles mixed scroll and text input in single write', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-mixed',
      sessionName: 'agentboard-ws-conn-scroll-mixed',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send text, then scroll, then more text
    proxy.write('hello\x1b[<64;40;12M world')

    // Should call copy-mode and scroll-up for the scroll sequence
    expect(harness.tmuxCalls).toContainEqual(['tmux', 'copy-mode', '-t', 'agentboard:@1'])
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'scroll-up',
    ])

    // Should also send the non-scroll text via send-keys -l
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-t',
      'agentboard:@1',
      '-l',
      '--',
      'hello world',
    ])

    await proxy.dispose()
  })

  test('ignores scroll release events (lowercase m)', async () => {
    const harness = createPipeHarness()

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-release',
      sessionName: 'agentboard-ws-conn-scroll-release',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Send scroll release event (lowercase 'm' = release)
    proxy.write('\x1b[<64;40;12m')

    // Should NOT call copy-mode for release events
    const copyModeCall = harness.tmuxCalls.find((call) => call.includes('copy-mode'))
    expect(copyModeCall).toBeUndefined()

    // Should pass through as regular input (or be stripped - either is acceptable)
    // The key is that it doesn't trigger scroll handling
    const scrollCall = harness.tmuxCalls.find((call) => call.includes('scroll-up'))
    expect(scrollCall).toBeUndefined()

    await proxy.dispose()
  })

  test('exits copy-mode when scroll-down reaches bottom (scroll_position=0)', async () => {
    let scrollPosition = '5' // Start scrolled up
    const harness = createPipeHarness()

    // Override spawnSync to return scroll position
    const originalSpawnSync = harness.spawnSync
    const spawnSyncWithScrollPos = (
      args: string[],
      options?: Parameters<typeof Bun.spawnSync>[1]
    ) => {
      if (args[1] === 'display-message' && args.includes('#{scroll_position}')) {
        return {
          exitCode: 0,
          stdout: Buffer.from(scrollPosition),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return originalSpawnSync(args, options)
    }

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-exit',
      sessionName: 'agentboard-ws-conn-scroll-exit',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: spawnSyncWithScrollPos,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0

    // Scroll down when NOT at bottom - should NOT cancel
    proxy.write('\x1b[<65;40;12M')
    let cancelCalls = harness.tmuxCalls.filter((call) => call.includes('cancel'))
    expect(cancelCalls.length).toBe(0)

    // Now simulate being at bottom
    scrollPosition = '0'
    harness.tmuxCalls.length = 0

    // Scroll down at bottom - should cancel copy-mode
    proxy.write('\x1b[<65;40;12M')
    cancelCalls = harness.tmuxCalls.filter((call) => call.includes('cancel'))
    expect(cancelCalls.length).toBe(1)
    expect(harness.tmuxCalls).toContainEqual([
      'tmux',
      'send-keys',
      '-X',
      '-t',
      'agentboard:@1',
      'cancel',
    ])

    await proxy.dispose()
  })

  test('scroll-up does not check scroll position or cancel', async () => {
    const harness = createPipeHarness()

    // Override spawnSync to track display-message calls
    const originalSpawnSync = harness.spawnSync
    let displayMessageCalled = false
    const spawnSyncTracking = (
      args: string[],
      options?: Parameters<typeof Bun.spawnSync>[1]
    ) => {
      if (args[1] === 'display-message') {
        displayMessageCalled = true
      }
      return originalSpawnSync(args, options)
    }

    const proxy = new PipePaneTerminalProxy({
      connectionId: 'conn-scroll-up-no-cancel',
      sessionName: 'agentboard-ws-conn-scroll-up-no-cancel',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: spawnSyncTracking,
      monitorTargets: false,
    })

    await proxy.start()
    await proxy.switchTo('agentboard:@1')
    harness.tmuxCalls.length = 0
    displayMessageCalled = false

    // Scroll up - should NOT check scroll position
    proxy.write('\x1b[<64;40;12M')

    expect(displayMessageCalled).toBe(false)
    const cancelCalls = harness.tmuxCalls.filter((call) => call.includes('cancel'))
    expect(cancelCalls.length).toBe(0)

    await proxy.dispose()
  })
})
