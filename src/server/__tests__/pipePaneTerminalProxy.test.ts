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
})
