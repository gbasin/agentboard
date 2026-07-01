import { afterEach, describe, expect, test } from 'bun:test'
import { SshTerminalProxy } from '../terminal/SshTerminalProxy'

function createSshHarness(options?: {
  ttyAvailable?: boolean
  spawnPipeOverride?: (args: string[]) => {
    exitCode: number
    stdout: string
    stderr: string
  }
}) {
  const { ttyAvailable = true, spawnPipeOverride } = options ?? {}
  const spawnCalls: Array<{
    args: string[]
    mode: 'terminal' | 'pipe'
    stdin?: string
  }> = []
  const terminalWrites: string[] = []
  let killed = false
  let terminalClosed = false
  let exitResolver: ((code: number) => void) | null = null

  // spawnSync is no longer used by SshTerminalProxy for SSH commands,
  // but the base class still has it available. Keep a no-op mock.
  const spawnSync = (
    _args: string[],
    _opts?: Parameters<typeof Bun.spawnSync>[1]
  ) => {
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }

  const spawn = (
    args: string[],
    spawnOpts: Parameters<typeof Bun.spawn>[1]
  ) => {
    const isTerminalMode =
      spawnOpts && typeof spawnOpts === 'object' && 'terminal' in spawnOpts

    const stdinOpt = (spawnOpts as { stdin?: Buffer } | undefined)?.stdin
    spawnCalls.push({
      args,
      mode: isTerminalMode ? 'terminal' : 'pipe',
      ...(stdinOpt !== undefined ? { stdin: stdinOpt.toString() } : {}),
    })

    if (isTerminalMode) {
      // Terminal mode — used by doStartCore for SSH attach
      return {
        terminal: {
          write: (data: string) => {
            terminalWrites.push(data)
          },
          resize: () => {},
          close: () => {
            terminalClosed = true
          },
        },
        exited: new Promise<number>((resolve) => {
          exitResolver = resolve
        }),
        kill: () => {
          killed = true
        },
      } as unknown as ReturnType<typeof Bun.spawn>
    }

    // Pipe mode — used by runTmuxAsync for command-channel SSH calls
    let result = { exitCode: 0, stdout: '', stderr: '' }

    if (spawnPipeOverride) {
      result = spawnPipeOverride(args)
    } else {
      const cmd = args.join(' ')
      if (cmd.includes('list-clients') && ttyAvailable) {
        result = { exitCode: 0, stdout: '/dev/pts/42\n', stderr: '' }
      }
    }

    return {
      exited: Promise.resolve(result.exitCode),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stdout))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(result.stderr))
          controller.close()
        },
      }),
      kill: () => {
        killed = true
      },
    } as unknown as ReturnType<typeof Bun.spawn>
  }

  return {
    spawn,
    spawnSync,
    spawnCalls,
    terminalWrites,
    wasKilled: () => killed,
    wasTerminalClosed: () => terminalClosed,
    resolveExit: (code = 0) => exitResolver?.(code),
  }
}

/** Flush the fire-and-forget async paste chain (each await = one microtask hop). */
async function flushAsync(rounds = 6) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('SshTerminalProxy', () => {
  let savedTimeout: number

  afterEach(() => {
    if (savedTimeout !== undefined) {
      SshTerminalProxy.STARTUP_TIMEOUT_MS = savedTimeout
    }
  })

  test('start succeeds when TTY is discovered', async () => {
    const harness = createSshHarness({ ttyAvailable: true })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-1',
      sessionName: 'test-proxy-session',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()

    expect(proxy.isReady()).toBe(true)
    expect(proxy.getClientTty()).toBe('/dev/pts/42')
    expect(proxy.getMode()).toBe('ssh')

    // Verify new-session was called via SSH (pipe mode)
    const newSessionCall = harness.spawnCalls.find(
      (c) =>
        c.mode === 'pipe' &&
        c.args.some((a) => a.includes('new-session'))
    )
    expect(newSessionCall).toBeDefined()

    // Verify attach was spawned (terminal mode)
    const attachCalls = harness.spawnCalls.filter((c) => c.mode === 'terminal')
    expect(attachCalls.length).toBe(1)
    const attachArgs = attachCalls[0].args
    expect(attachArgs).toContain('ssh')
    expect(attachArgs).toContain('-tt')
    expect(attachArgs).toContain('remote-host')

    await proxy.dispose()
  })

  test('doStart rejects with ERR_START_TIMEOUT when SSH hangs', async () => {
    savedTimeout = SshTerminalProxy.STARTUP_TIMEOUT_MS
    SshTerminalProxy.STARTUP_TIMEOUT_MS = 200

    const harness = createSshHarness({ ttyAvailable: false })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-timeout',
      sessionName: 'test-timeout-session',
      baseSession: 'agentboard',
      host: 'unreachable-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await expect(proxy.start()).rejects.toMatchObject({
      code: 'ERR_START_TIMEOUT',
      retryable: true,
    })

    expect(harness.wasKilled()).toBe(true)
    expect(proxy.isReady()).toBe(false)
  })

  test('startup timeout kills the spawned SSH process', async () => {
    savedTimeout = SshTerminalProxy.STARTUP_TIMEOUT_MS
    SshTerminalProxy.STARTUP_TIMEOUT_MS = 150

    const harness = createSshHarness({ ttyAvailable: false })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-kill',
      sessionName: 'test-kill-session',
      baseSession: 'agentboard',
      host: 'slow-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    try {
      await proxy.start()
    } catch {
      // Expected
    }

    expect(harness.wasKilled()).toBe(true)
    expect(harness.wasTerminalClosed()).toBe(true)
  })

  test('startup timeout does not allow a late READY transition if TTY appears after timeout', async () => {
    savedTimeout = SshTerminalProxy.STARTUP_TIMEOUT_MS
    SshTerminalProxy.STARTUP_TIMEOUT_MS = 20

    let listClientsCalls = 0
    const harness = createSshHarness({
      ttyAvailable: false,
      spawnPipeOverride: (args) => {
        const cmd = args.join(' ')
        if (cmd.includes('list-clients')) {
          listClientsCalls += 1
          // Simulate a slow TTY discovery: empty first, then present.
          if (listClientsCalls >= 2) {
            return { exitCode: 0, stdout: '/dev/pts/42\n', stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })

    const proxy = new SshTerminalProxy({
      connectionId: 'conn-late-tty',
      sessionName: 'test-late-tty-session',
      baseSession: 'agentboard',
      host: 'slow-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await expect(proxy.start()).rejects.toMatchObject({
      code: 'ERR_START_TIMEOUT',
      retryable: true,
    })

    // If the core path isn't cancelled, it could still discover a TTY and flip to READY.
    await new Promise((r) => setTimeout(r, 150))
    expect(proxy.isReady()).toBe(false)
    expect(proxy.getClientTty()).toBeNull()
  })

  test('runTmuxAsync routes commands through SSH with pipe mode', async () => {
    const harness = createSshHarness({ ttyAvailable: true })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-2',
      sessionName: 'test-pipe-verify',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()

    // All pipe-mode calls should be SSH commands
    const pipeCalls = harness.spawnCalls.filter((c) => c.mode === 'pipe')
    expect(pipeCalls.length).toBeGreaterThan(0)
    for (const call of pipeCalls) {
      expect(call.args[0]).toBe('ssh')
    }

    await proxy.dispose()
  })

  test('dispose kills process and cleans up remote session', async () => {
    const harness = createSshHarness({ ttyAvailable: true })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-dispose',
      sessionName: 'test-dispose-session',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()
    expect(proxy.isReady()).toBe(true)

    await proxy.dispose()

    expect(harness.wasKilled()).toBe(true)
    expect(proxy.isReady()).toBe(false)
    expect(proxy.getClientTty()).toBeNull()

    // Verify kill-session was called (pipe mode)
    const killCall = harness.spawnCalls.find(
      (c) => c.mode === 'pipe' && c.args.some((a) => a.includes('kill-session'))
    )
    expect(killCall).toBeDefined()
  })

  test('start is idempotent when already started', async () => {
    const harness = createSshHarness({ ttyAvailable: true })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-idem',
      sessionName: 'test-idem-session',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()
    const callCountAfterFirst = harness.spawnCalls.filter(
      (c) => c.mode === 'terminal'
    ).length

    // Second start should not spawn again
    await proxy.start()
    const callCountAfterSecond = harness.spawnCalls.filter(
      (c) => c.mode === 'terminal'
    ).length
    expect(callCountAfterSecond).toBe(callCountAfterFirst)

    await proxy.dispose()
  })

  test('doStart rejects with ERR_SESSION_CREATE_FAILED on SSH failure', async () => {
    const harness = createSshHarness({
      spawnPipeOverride: () => ({
        exitCode: 255,
        stdout: '',
        stderr: 'ssh: connect to host bad-host: Connection refused',
      }),
    })

    const proxy = new SshTerminalProxy({
      connectionId: 'conn-fail',
      sessionName: 'test-fail-session',
      baseSession: 'agentboard',
      host: 'bad-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await expect(proxy.start()).rejects.toMatchObject({
      code: 'ERR_SESSION_CREATE_FAILED',
    })
  })

  test('paste stages via load-buffer stdin and replays with paste-buffer', async () => {
    const harness = createSshHarness({ ttyAvailable: true })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-paste',
      sessionName: 'test-paste-session',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()
    proxy.paste('line1\r\nline2\nline3')
    await flushAsync()

    // Payload rides ssh stdin into remote `tmux load-buffer -` (no argv limit),
    // CRLF normalized to LF, staged in a unique per-paste buffer.
    const loadCall = harness.spawnCalls.find(
      (c) => c.mode === 'pipe' && c.args.some((a) => a.includes('load-buffer'))
    )
    expect(loadCall).toBeDefined()
    const loadCmd = loadCall!.args[loadCall!.args.length - 1]
    expect(loadCmd).toContain('agentboard-paste-conn-paste-1')
    expect(loadCall!.stdin).toBe('line1\nline2\nline3')

    // Replayed with -d -p against the remote session's active pane.
    const pasteCall = harness.spawnCalls.find(
      (c) => c.mode === 'pipe' && c.args.some((a) => a.includes('paste-buffer'))
    )
    expect(pasteCall).toBeDefined()
    const pasteCmd = pasteCall!.args[pasteCall!.args.length - 1]
    expect(pasteCmd).toContain('-d')
    expect(pasteCmd).toContain('-p')
    expect(pasteCmd).toContain('agentboard-paste-conn-paste-1')
    expect(pasteCmd).toContain('test-paste-session')

    // Paste must never reach the raw interactive pty (auto-submit risk).
    expect(harness.terminalWrites).toEqual([])

    await proxy.dispose()
  })

  test('paste load-buffer failure drops the paste without a raw pty write', async () => {
    const harness = createSshHarness({
      spawnPipeOverride: (args) => {
        const cmd = args.join(' ')
        if (cmd.includes('list-clients')) {
          return { exitCode: 0, stdout: '/dev/pts/42\n', stderr: '' }
        }
        if (cmd.includes('load-buffer')) {
          return { exitCode: 1, stdout: '', stderr: 'tmux gone' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-paste-fail',
      sessionName: 'test-paste-fail',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()
    proxy.paste('a\nb')
    await flushAsync()

    // No replay after the failed staging, and no fallback into the pty —
    // a raw multi-line write is the auto-submit bug.
    expect(
      harness.spawnCalls.some(
        (c) => c.mode === 'pipe' && c.args.some((a) => a.includes('paste-buffer'))
      )
    ).toBe(false)
    expect(harness.terminalWrites).toEqual([])

    await proxy.dispose()
  })

  test('paste-buffer failure cleans up the staged buffer', async () => {
    const harness = createSshHarness({
      spawnPipeOverride: (args) => {
        const cmd = args.join(' ')
        if (cmd.includes('list-clients')) {
          return { exitCode: 0, stdout: '/dev/pts/42\n', stderr: '' }
        }
        if (cmd.includes('paste-buffer')) {
          return { exitCode: 1, stdout: '', stderr: 'no such target' }
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    })
    const proxy = new SshTerminalProxy({
      connectionId: 'conn-paste-clean',
      sessionName: 'test-paste-clean',
      baseSession: 'agentboard',
      host: 'remote-host',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
    })

    await proxy.start()
    proxy.paste('a\nb')
    await flushAsync()

    expect(
      harness.spawnCalls.some(
        (c) => c.mode === 'pipe' && c.args.some((a) => a.includes('delete-buffer'))
      )
    ).toBe(true)
    expect(harness.terminalWrites).toEqual([])

    await proxy.dispose()
  })
})
