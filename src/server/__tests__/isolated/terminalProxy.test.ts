import { describe, expect, test } from 'bun:test'
import { PtyTerminalProxy as TerminalProxy } from '../../terminal'
import { buildTmuxFormat } from '../../tmuxFormat'

const CLIENT_TTY_OUTPUT = `${buildTmuxFormat(['/dev/pts/9', '4242'])}\n`
const CLIENT_TTY_FORMAT = buildTmuxFormat(['#{client_tty}', '#{client_pid}'])
const CLIENT_IDENTITY_FORMAT = buildTmuxFormat([
  '#{client_tty}',
  '#{session_name}',
  '#{window_id}',
])

function getTmuxCommand(args: string[]): string {
  const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
  return tmuxArgs[0] === '-u' ? tmuxArgs[1] ?? '' : tmuxArgs[0] ?? ''
}

function createSpawnHarness({ tmuxVersion = 'tmux 3.4' } = {}) {
  const spawnCalls: Array<{
    args: string[]
    options: Parameters<typeof Bun.spawn>[1]
  }> = []
  const spawnSyncCalls: Array<{
    args: string[]
    options?: Parameters<typeof Bun.spawnSync>[1]
  }> = []
  const writes: Array<string | Uint8Array> = []
  const resizes: Array<{ cols: number; rows: number }> = []
  let closed = false
  let killed = false
  let exitResolver: (() => void) | null = null
  let dataHandler: ((terminal: Bun.Terminal, data: Uint8Array) => void) | null =
    null
  let exitHandler: ((terminal: Bun.Terminal, code: number, signal: string | null) => void) | null =
    null
  let activeTarget = 'agentboard-ws-abc:@1'

  const exited = new Promise<void>((resolve) => {
    exitResolver = resolve
  })

  const terminal = {
    write: (data: string | BufferSource) => {
      if (typeof data === 'string') {
        writes.push(data)
        return
      }
      const view =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      writes.push(view.slice())
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
    spawnSyncCalls.push({ args, options: _options })
    const command = getTmuxCommand(args)
    if (command === '-V') {
      return {
        exitCode: 0,
        stdout: Buffer.from(`${tmuxVersion}\n`),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (command === 'list-clients') {
      // Real tmux expands list-clients formats per client, so answer by the
      // requested format: the tty+pid discovery format keeps its canned
      // output, while the identity format reports each client's session from
      // the tracked switch-client state. A second, more recently active
      // client is listed first — display-message -p -c would have reported
      // that one's session (the bug the identity read was moved off of).
      const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
      const formatIndex = tmuxArgs.indexOf('-F')
      const format = formatIndex >= 0 ? tmuxArgs[formatIndex + 1] ?? '' : ''
      if (format === CLIENT_IDENTITY_FORMAT) {
        const [sessionName, windowTarget = '@1'] = activeTarget.split(':')
        const windowId = windowTarget.includes('.')
          ? windowTarget.slice(0, windowTarget.indexOf('.'))
          : windowTarget
        const rows = [
          buildTmuxFormat(['/dev/pts/1', 'other-session', '@9']),
          buildTmuxFormat(['/dev/pts/9', sessionName, windowId || '@1']),
        ]
        return {
          exitCode: 0,
          stdout: Buffer.from(rows.join('\n') + '\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(CLIENT_TTY_OUTPUT),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (command === 'switch-client') {
      const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
      const targetIndex = tmuxArgs.indexOf('-t')
      if (targetIndex >= 0 && tmuxArgs[targetIndex + 1]) {
        activeTarget = tmuxArgs[targetIndex + 1]
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (command === 'display-message') {
      const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
      const clientIndex = tmuxArgs.indexOf('-c')
      const targetIndex = tmuxArgs.indexOf('-t')
      const target =
        clientIndex >= 0 ? activeTarget : targetIndex >= 0 ? tmuxArgs[targetIndex + 1] : ''
      const [sessionName, windowTarget = '@1'] = target.split(':')
      const windowId = windowTarget.includes('.')
        ? windowTarget.slice(0, windowTarget.indexOf('.'))
        : windowTarget
      return {
        exitCode: 0,
        stdout: Buffer.from(buildTmuxFormat([sessionName, windowId || '@1']) + '\n'),
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

// Stateful fake tmux for the external-grouped-session tests below: tracks
// which sessions exist and their window ids so has-session/new-session/
// kill-session/list-windows behave like the real thing instead of the
// generic harness's always-empty-success default (which made
// derivedContainsWindow vacuously false and left this whole area untested).
interface FakeSession {
  windows: string[]
  group?: string
}

function ok(stdout: string): ReturnType<typeof Bun.spawnSync> {
  return { exitCode: 0, stdout: Buffer.from(stdout), stderr: Buffer.from('') } as ReturnType<typeof Bun.spawnSync>
}
function fail(stderr: string): ReturnType<typeof Bun.spawnSync> {
  return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from(stderr) } as ReturnType<typeof Bun.spawnSync>
}

function createStatefulTmuxSpawnSync(
  sessions: Map<string, FakeSession>,
  initialClientSession: string
) {
  let clientSession = initialClientSession
  let clientWindow: string | null = null
  const calls: string[][] = []
  const arg = (args: string[], flag: string) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] ?? '' : ''
  }
  const currentWindow = () =>
    clientWindow ?? sessions.get(clientSession)?.windows[0] ?? '@1'
  const spawnSync = (args: string[]) => {
    calls.push(args)
    const command = getTmuxCommand(args)
    if (command === '-V') {
      // Without this the version probe falls through to the ok('') default,
      // tmuxSupportsClientFeatures fails closed, and every test here would
      // attach without -T sync — unlike the real tmux 3.4 these tests model.
      return ok('tmux 3.4\n')
    }
    if (command === 'list-clients') {
      const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
      const format = tmuxArgs[tmuxArgs.indexOf('-F') + 1] ?? ''
      if (format === CLIENT_IDENTITY_FORMAT) {
        return ok(buildTmuxFormat(['/dev/pts/9', clientSession, currentWindow()]) + '\n')
      }
      return ok(CLIENT_TTY_OUTPUT)
    }
    if (command === 'has-session') {
      const name = arg(args, '-t').replace(/^=/, '')
      return sessions.has(name) ? ok('') : fail("can't find session")
    }
    if (command === 'new-session') {
      const rawName = arg(args, '-t').replace(/^=/, '')
      const newName = arg(args, '-s')
      const raw = sessions.get(rawName)
      if (!raw) return fail("can't find session")
      sessions.set(newName, { windows: [...raw.windows] })
      return ok('')
    }
    if (command === 'kill-session') {
      sessions.delete(arg(args, '-t').replace(/^=/, ''))
      return ok('')
    }
    if (command === 'list-windows') {
      const windows = sessions.get(arg(args, '-t').replace(/^=/, ''))?.windows ?? []
      return ok(windows.length ? windows.join('\n') + '\n' : '')
    }
    if (command === 'list-sessions') {
      // Ungrouped sessions report an empty group, matching real tmux.
      const rows = [...sessions.entries()].map(([name, s]) =>
        buildTmuxFormat([name, s.group ?? ''])
      )
      return ok(rows.join('\n') + '\n')
    }
    if (command === 'switch-client') {
      const target = arg(args, '-t').replace(/^=/, '')
      const colonIdx = target.indexOf(':')
      if (colonIdx > 0) {
        clientSession = target.slice(0, colonIdx)
        clientWindow = target.slice(colonIdx + 1)
      } else {
        clientSession = target
        clientWindow = null
      }
      return ok('')
    }
    if (command === 'display-message') {
      // readTargetIdentity always calls this with -t <target> (not -c); it
      // reports the TARGET's own session:window, not the client's position.
      const target = arg(args, '-t').replace(/^=/, '')
      const colonIdx = target.indexOf(':')
      const sessionName = colonIdx > 0 ? target.slice(0, colonIdx) : target
      const windowId =
        colonIdx > 0
          ? target.slice(colonIdx + 1)
          : sessions.get(sessionName)?.windows[0] ?? '@1'
      return ok(buildTmuxFormat([sessionName, windowId]))
    }
    return ok('')
  }
  return { spawnSync, calls, getClientSession: () => clientSession }
}

// Mirrors PtyTerminalProxy's private resolveExternalGroupedTarget naming so
// tests can seed/assert against the exact derived session name without
// hardcoding a hash that would drift from the implementation.
function deriveExternalSessionName(managedSession: string, rawSession: string): string {
  const sanitized = rawSession.replace(/[^A-Za-z0-9_-]/g, '-')
  const suffix = Bun.hash(rawSession).toString(36).slice(0, 6)
  return `${managedSession}-x-${sanitized}-${suffix}`
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

    expect(harness.spawnSyncCalls).toEqual(
      expect.arrayContaining([
        {
          args: [
            'tmux',
            'new-session',
            '-d',
            '-t',
            'agentboard',
            '-s',
            'agentboard-ws-abc',
          ],
          options: expect.objectContaining({ timeout: 15000 }),
        },
        {
          args: ['tmux', '-u', 'list-clients', '-F', CLIENT_TTY_FORMAT],
          options: expect.objectContaining({ timeout: 3000 }),
        },
      ])
    )
    expect(harness.spawnCalls[0]?.args).toEqual([
      'tmux',
      '-u',
      '-T',
      'sync',
      'attach',
      '-t',
      'agentboard-ws-abc',
    ])

    harness.emitData('hello')
    expect(received).toEqual(['hello'])
    expect(proxy.getClientTty()).toBe('/dev/pts/9')
    expect(proxy.isReady()).toBe(true)
  })

  test('AGENTBOARD_TMUX_SYNC=0 disables the sync feature', async () => {
    const saved = process.env.AGENTBOARD_TMUX_SYNC
    process.env.AGENTBOARD_TMUX_SYNC = '0'
    try {
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

      expect(harness.spawnCalls[0]?.args).toEqual([
        'tmux',
        '-u',
        'attach',
        '-t',
        'agentboard-ws-abc',
      ])
    } finally {
      if (saved === undefined) {
        delete process.env.AGENTBOARD_TMUX_SYNC
      } else {
        process.env.AGENTBOARD_TMUX_SYNC = saved
      }
    }
  })

  test('omits -T sync when tmux predates client feature flags', async () => {
    const harness = createSpawnHarness({ tmuxVersion: 'tmux 3.1c' })
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

    expect(harness.spawnCalls[0]?.args).toEqual([
      'tmux',
      '-u',
      'attach',
      '-t',
      'agentboard-ws-abc',
    ])
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
    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'switch-client', '-c', '/dev/pts/9', '-t', 'external:@2'],
      options: expect.objectContaining({ timeout: 3000 }),
    })
    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'refresh-client', '-t', '/dev/pts/9'],
      options: expect.objectContaining({ timeout: 3000 }),
    })
    expect(proxy.getCurrentWindow()).toBe('@2')
  })

  test('switchTo verifies against our own client when another client is more recently active', async () => {
    // The harness lists a foreign client (/dev/pts/1, other-session) FIRST in
    // list-clients output — the position display-message -p -c would have
    // reported. Verification must read our own client's row instead; a
    // regression back to most-recently-active semantics fails this switch.
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
    await proxy.switchTo('external:@2')

    expect(proxy.getCurrentWindow()).toBe('@2')
    expect(
      harness.spawnSyncCalls.some(
        (call) =>
          getTmuxCommand(call.args) === 'display-message' &&
          call.args.includes('-c')
      )
    ).toBe(false)
  })

  test('paste stages via load-buffer stdin and replays into the grouped session', async () => {
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
    proxy.paste('line1\r\nline2\nline3')

    // Payload travels via stdin (no argv size limit), CRLF normalized to LF.
    const loadCall = harness.spawnSyncCalls.find(
      (call) => getTmuxCommand(call.args) === 'load-buffer'
    )
    expect(loadCall?.args).toEqual([
      'tmux',
      'load-buffer',
      '-b',
      'agentboard-paste-abc-1',
      '-',
    ])
    expect(
      (loadCall?.options as { stdin?: Buffer } | undefined)?.stdin?.toString()
    ).toBe('line1\nline2\nline3')

    // Replayed into the grouped session's active pane; -p defers bracketing to
    // the real pane's mode, -d deletes the staged buffer.
    expect(harness.spawnSyncCalls).toContainEqual({
      args: [
        'tmux',
        'paste-buffer',
        '-d',
        '-p',
        '-b',
        'agentboard-paste-abc-1',
        '-t',
        'agentboard-ws-abc',
      ],
      options: expect.objectContaining({ timeout: 3000 }),
    })

    // Paste must never reach the raw pty write path (auto-submit risk).
    expect(harness.writes).toEqual([])
  })

  test('paste targets the external session after a verified switch', async () => {
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
    await proxy.switchTo('external:@2')
    proxy.paste('hello')

    // The client left the grouped ws session, so the paste must follow it
    // into the external session (bare name — paste-buffer's target-pane
    // parser rejects the =name exact-match form), not the ws session whose
    // active window is its own bootstrap window.
    expect(harness.spawnSyncCalls).toContainEqual({
      args: [
        'tmux',
        'paste-buffer',
        '-d',
        '-p',
        '-b',
        'agentboard-paste-abc-1',
        '-t',
        'external',
      ],
      options: expect.objectContaining({ timeout: 3000 }),
    })
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

    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'switch-client', '-c', '/dev/pts/9', '-t', 'agentboard-ws-abc:@2'],
      options: expect.objectContaining({ timeout: 3000 }),
    })
    expect(proxy.getCurrentWindow()).toBe('@2')
  })

  test('switchTo rewrites session-only base-session targets to grouped session', async () => {
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
    await proxy.switchTo('agentboard')

    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'switch-client', '-c', '/dev/pts/9', '-t', 'agentboard-ws-abc'],
      options: expect.objectContaining({ timeout: 3000 }),
    })
    expect(proxy.getCurrentWindow()).toBe('agentboard-ws-abc')
  })

  test('copies mouse setting from base session to grouped session', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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

  test('enables set-clipboard so copies land in a tmux paste buffer', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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
      connectionId: 'clipboard-test',
      sessionName: 'agentboard-ws-clipboard-test',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()

    // set-clipboard is a server option; `on` makes tmux store a paste buffer
    // for the clipboard poll instead of only forwarding OSC 52 outward.
    expect(spawnSyncCalls).toContainEqual([
      'tmux',
      'set-option',
      '-s',
      'set-clipboard',
      'on',
    ])
  })

  test('copies mouse=off setting from base session to grouped session', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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
        (call) => getTmuxCommand(call) === 'set-option' && call.includes('mouse')
      )
    ).toBe(false)
  })

  test('continues when reading base mouse setting fails', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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
        (call) => getTmuxCommand(call) === 'set-option' && call.includes('mouse')
      )
    ).toBe(false)
    expect(proxy.isReady()).toBe(true)
  })

  test('continues when applying grouped mouse setting fails', async () => {
    const spawnSyncCalls: string[][] = []
    const spawnSync = (args: string[], _options?: Parameters<typeof Bun.spawnSync>[1]) => {
      spawnSyncCalls.push(args)
      const command = getTmuxCommand(args)
      if (command === 'list-clients') {
        return {
          exitCode: 0,
          stdout: Buffer.from(CLIENT_TTY_OUTPUT),
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

    expect(harness.spawnCalls[0]?.args).toEqual([
      'tmux',
      '-u',
      '-T',
      'sync',
      'attach',
      '-t',
      'agentboard-ws-abc',
    ])
    expect(harness.writes).toEqual([new TextEncoder().encode('ls')])
    expect(harness.resizes).toEqual([{ cols: 120, rows: 40 }])
    expect(harness.wasClosed()).toBe(true)
    expect(harness.wasKilled()).toBe(true)
    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'kill-session', '-t', 'agentboard-ws-abc'],
      options: expect.objectContaining({ timeout: 15000 }),
    })
  })

  test('writes terminal input as explicit UTF-8 bytes', async () => {
    const harness = createSpawnHarness()
    const proxy = new TerminalProxy({
      connectionId: 'unicode',
      sessionName: 'agentboard-ws-unicode',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    proxy.write('áéíñü-你好-🚀')

    expect(harness.writes).toEqual([
      new TextEncoder().encode('áéíñü-你好-🚀'),
    ])
  })

  test('disposes the grouped session when tmux attach spawn fails', async () => {
    const harness = createSpawnHarness()
    const failingSpawn = (
      args: string[],
      options: Parameters<typeof Bun.spawn>[1]
    ) => {
      harness.spawnCalls.push({ args, options })
      throw new Error('pty exhausted')
    }

    const proxy = new TerminalProxy({
      connectionId: 'attach-fail',
      sessionName: 'agentboard-ws-attach-fail',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: failingSpawn,
      spawnSync: harness.spawnSync,
      wait: async () => {},
    })

    await expect(proxy.start()).rejects.toMatchObject({
      code: 'ERR_TMUX_ATTACH_FAILED',
    })

    // new-session created the grouped session before attach; dispose must
    // kill it so a failed spawn cannot orphan a pty-holding session.
    expect(harness.spawnSyncCalls).toContainEqual({
      args: [
        'tmux',
        'new-session',
        '-d',
        '-t',
        'agentboard',
        '-s',
        'agentboard-ws-attach-fail',
      ],
      options: expect.objectContaining({ timeout: 15000 }),
    })
    expect(harness.spawnSyncCalls).toContainEqual({
      args: ['tmux', 'kill-session', '-t', 'agentboard-ws-attach-fail'],
      options: expect.objectContaining({ timeout: 15000 }),
    })
    expect(proxy.isReady()).toBe(false)
  })

  test('ensureEffectiveTarget creates a derived grouped session for an external target', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1', '@2'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work:@1')

    expect(effective).toMatch(/^agentboard-ws-abc-x-work-[0-9a-z]+:@1$/)
    expect(
      fake.calls.some(
        (c) => getTmuxCommand(c) === 'new-session' && c.includes('=work')
      )
    ).toBe(true)
    expect(
      fake.calls.some(
        (c) => getTmuxCommand(c) === 'list-windows' && c.some((a) => a.startsWith('=agentboard-ws-abc-x-work-'))
      )
    ).toBe(true)
  })

  test('ensureEffectiveTarget short-circuits on the warm path without re-issuing has-session', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    proxy.ensureEffectiveTarget('work:@1')
    const callsAfterFirst = fake.calls.length
    const second = proxy.ensureEffectiveTarget('work:@1')
    const hasSessionCallsAfterSecond = fake.calls
      .slice(callsAfterFirst)
      .filter((c) => getTmuxCommand(c) === 'has-session')

    expect(second).toMatch(/^agentboard-ws-abc-x-work-[0-9a-z]+:@1$/)
    expect(hasSessionCallsAfterSecond).toHaveLength(0)
  })

  test('recovers from a stale derived session bound to a killed-and-recreated raw session', async () => {
    const staleDerived = deriveExternalSessionName('agentboard-ws-abc', 'work')
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      // Simulates a ghost: a derived session from an earlier connection,
      // still holding the OLD windows of a "work" session that has since
      // been killed and recreated with different window ids.
      [staleDerived, { windows: ['@1'] }],
      ['work', { windows: ['@5'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work:@5')

    // Resolves through the same derived name (recreated in place), now bound
    // to work's current windows instead of the stale ones.
    expect(effective).toBe(`${staleDerived}:@5`)
    expect(sessions.get(staleDerived)?.windows).toEqual(['@5'])
    // The stale ghost got killed along the way (before being recreated).
    expect(
      fake.calls.some(
        (c) =>
          getTmuxCommand(c) === 'kill-session' && c.includes(`=${staleDerived}`)
      )
    ).toBe(true)
  })

  test('evacuates the client before killing a stale derived session it is attached to', async () => {
    const staleDerived = deriveExternalSessionName('agentboard-ws-abc', 'work')
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      [staleDerived, { windows: ['@1'] }],
      ['work', { windows: ['@5'] }],
    ])
    // The client is sitting on the stale derived session when the switch
    // that discovers it's stale happens.
    const fake = createStatefulTmuxSpawnSync(sessions, staleDerived)
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    proxy.ensureEffectiveTarget('work:@5')

    const evacuateIndex = fake.calls.findIndex(
      (c) =>
        getTmuxCommand(c) === 'switch-client' &&
        c.includes('=agentboard-ws-abc')
    )
    const killIndex = fake.calls.findIndex(
      (c) =>
        getTmuxCommand(c) === 'kill-session' && c.includes(`=${staleDerived}`)
    )
    expect(evacuateIndex).toBeGreaterThanOrEqual(0)
    expect(killIndex).toBeGreaterThan(evacuateIndex)
  })

  test('gives up and falls back to the raw target when recreation still lands in a stale group', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@5'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    // The derived session never actually contains the requested window, no
    // matter how many times it's (re)created — simulates the group-name
    // race where new-session -t joins a surviving stale group instead of
    // the recreated raw session, without needing to model that race itself.
    const originalSpawnSync = fake.spawnSync
    const spawnSync = (args: string[]) => {
      if (getTmuxCommand(args) === 'list-windows') {
        return ok('')
      }
      return originalSpawnSync(args)
    }
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work:@5')

    // Degrades to the raw target unchanged rather than looping or throwing.
    expect(effective).toBe('work:@5')
    expect(
      fake.calls.some(
        (c) =>
          getTmuxCommand(c) === 'kill-session' &&
          c.some((a) => a.startsWith('=agentboard-ws-abc-x-work-'))
      )
    ).toBe(true)
  })

  test('bare-session targets also give up on a stale group after recreation, instead of trusting it blindly', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@5'], group: 'work' }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    // The derived session's group never matches the raw session's group, no
    // matter how many times it's (re)created -- same race as the window-id
    // case, but for a bare-session target (no ":@id" suffix), which the
    // recreation path used to skip re-validating entirely.
    const originalSpawnSync = fake.spawnSync
    const spawnSync = (args: string[]) => {
      if (getTmuxCommand(args) === 'list-sessions') {
        const derived = deriveExternalSessionName('agentboard-ws-abc', 'work')
        const rows = [
          buildTmuxFormat(['work', 'work']),
          buildTmuxFormat([derived, 'stale-group']),
        ]
        return ok(rows.join('\n') + '\n')
      }
      return originalSpawnSync(args)
    }
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work') // no ":@id" suffix

    // Degrades to the raw target unchanged rather than trusting a
    // freshly-recreated session that landed in the wrong group.
    expect(effective).toBe('work')
    expect(
      fake.calls.some(
        (c) =>
          getTmuxCommand(c) === 'kill-session' &&
          c.some((a) => a.startsWith('=agentboard-ws-abc-x-work-'))
      )
    ).toBe(true)
  })

  test('falls back to the raw target when the raw session no longer exists', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      // "work" is absent — killed with no replacement.
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work:@5')

    expect(effective).toBe('work:@5')
    expect(
      fake.calls.some((c) => getTmuxCommand(c) === 'new-session' && c.includes('=work'))
    ).toBe(false)
  })

  test('bare-session targets validate via session-group membership, not window-set', async () => {
    // A pre-existing, correctly-grouped derived session so the warm
    // re-validation branch (has-session succeeds) runs; only that branch
    // reads sessionGroupsMatch/derivedContainsWindow at all.
    const derived = deriveExternalSessionName('agentboard-ws-abc', 'work')
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1'], group: 'work' }],
      [derived, { windows: ['@1'], group: 'work' }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    const effective = proxy.ensureEffectiveTarget('work') // no ":@id" suffix

    expect(effective).toBe(derived)
    expect(
      fake.calls.some((c) => getTmuxCommand(c) === 'list-sessions')
    ).toBe(true)
    // Bare targets have no window to check, so the window-set path never runs.
    expect(
      fake.calls.some((c) => getTmuxCommand(c) === 'list-windows')
    ).toBe(false)
  })

  test('releaseUnusedExternalGroupedSessions kills derived sessions the client already switched away from', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work-a', { windows: ['@1'] }],
      ['work-b', { windows: ['@2'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    await proxy.switchTo('work-a:@1')
    const derivedA = fake.getClientSession()
    expect(sessions.has(derivedA)).toBe(true)

    await proxy.switchTo('work-b:@2')

    // Switching away kills the now-unused derived-a session...
    expect(sessions.has(derivedA)).toBe(false)
    // ...but the one just switched into survives.
    expect(sessions.has(fake.getClientSession())).toBe(true)
  })

  test('dispose kills every tracked external grouped session', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    await proxy.switchTo('work:@1')
    const derivedName = fake.getClientSession()
    expect(sessions.has(derivedName)).toBe(true)

    await proxy.dispose()

    expect(
      fake.calls.some(
        (c) => getTmuxCommand(c) === 'kill-session' && c.includes(`=${derivedName}`)
      )
    ).toBe(true)
  })

  test('disposed proxy does not resurrect a derived session on ensureEffectiveTarget', async () => {
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')
    const harness = createSpawnHarness()

    const proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: harness.spawn,
      spawnSync: fake.spawnSync,
      wait: async () => {},
    })

    await proxy.start()
    await proxy.dispose()

    const callsBeforeRace = fake.calls.length
    // Simulates an in-flight attach that loses the race with a WebSocket
    // close: the caller still holds a reference to this (now-disposed) proxy
    // and calls ensureEffectiveTarget on it, as switchTo() would internally.
    const effective = proxy.ensureEffectiveTarget('work:@1')

    expect(effective).toBe('work:@1')
    expect(fake.calls.length).toBe(callsBeforeRace)
    expect(
      fake.calls
        .slice(callsBeforeRace)
        .some((c) => getTmuxCommand(c) === 'new-session')
    ).toBe(false)
  })

  test('a dispose() that lands mid-switchTo still blocks a later resurrection (the case the disposed flag exists for)', async () => {
    // The test above (disposed proxy does not resurrect...) is satisfied
    // just as well by the pre-existing `state === DEAD` check, because
    // dispose() sets state to DEAD synchronously before this test ever calls
    // ensureEffectiveTarget again -- it doesn't actually prove `disposed` is
    // load-bearing. This test reproduces the real race the flag guards
    // against: dispose() runs WHILE a switchTo() is suspended mid-flight
    // (e.g. the WebSocket closed while verifyClientTarget was retrying).
    // switchTo()'s own completion (success or failure) unconditionally
    // writes state back to READY afterward, "reviving" it -- only the
    // disposed flag (never touched by switchTo) still remembers we're gone.
    const sessions = new Map<string, FakeSession>([
      ['agentboard', { windows: ['@0'] }],
      ['work', { windows: ['@1'] }],
    ])
    const fake = createStatefulTmuxSpawnSync(sessions, 'agentboard-ws-abc')

    let proxy!: TerminalProxy
    let disposeStarted = false
    // verifyClientTarget only calls wait() once its first (no-wait) identity
    // check fails to match, i.e. only once forced into its retry loop below.
    const wait = async () => {
      if (!disposeStarted) {
        disposeStarted = true
        await proxy.dispose()
      }
    }

    let identityChecks = 0
    const spawnSync = (args: string[]) => {
      const tmuxArgs = args[0] === 'tmux' ? args.slice(1) : args
      const formatIndex = tmuxArgs.indexOf('-F')
      const format = formatIndex >= 0 ? tmuxArgs[formatIndex + 1] ?? '' : ''
      if (getTmuxCommand(args) === 'list-clients' && format === CLIENT_IDENTITY_FORMAT) {
        identityChecks += 1
        if (identityChecks === 1) {
          // First check reports the client still on its old window, so
          // verifyClientTarget's iteration 1 mismatches and falls into the
          // retry loop -- which is where dispose() gets to run via wait().
          return ok(buildTmuxFormat(['/dev/pts/9', 'agentboard-ws-abc', '@0']))
        }
      }
      return fake.spawnSync(args)
    }

    proxy = new TerminalProxy({
      connectionId: 'abc',
      sessionName: 'agentboard-ws-abc',
      baseSession: 'agentboard',
      onData: () => {},
      spawn: createSpawnHarness().spawn,
      spawnSync,
      wait,
    })

    await proxy.start()
    // Resolves without throwing: doSwitch's own catch swallows the failure
    // mode here (a stale-map eviction at worst), which is not what this test
    // is about -- what matters is what state switchTo() leaves behind.
    await proxy.switchTo('work:@1').catch(() => {})

    expect(disposeStarted).toBe(true)
    // The race really happened: switchTo()'s completion clobbered state back
    // away from DEAD after dispose() had already set it.
    expect((proxy as unknown as { state: string }).state).not.toBe('DEAD')

    const callsBeforeRace = fake.calls.length
    const effective = proxy.ensureEffectiveTarget('work:@1')

    expect(effective).toBe('work:@1')
    expect(fake.calls.length).toBe(callsBeforeRace)
  })
})
