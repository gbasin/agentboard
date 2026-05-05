import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config'
import { SessionManager } from '../SessionManager'
import {
  BOOTSTRAP_WINDOW_COMMAND,
  BOOTSTRAP_WINDOW_NAME,
  TMUX_FIELD_SEPARATOR,
} from '../tmuxFormat'
import { TmuxTimeoutError } from '../tmuxTimeout'

const bunAny = Bun as typeof Bun & {
  spawnSync: typeof Bun.spawnSync
}

const originalSpawnSync = bunAny.spawnSync

interface WindowState {
  id: string
  index: number
  name: string
  path: string
  activity: number
  creation?: number
  command: string
}

interface SessionState {
  name: string
  group?: string
  windows: WindowState[]
}

function normalizeParsedTmuxArgs(args: string[]): string[] {
  return args[0] === '-u' ? args.slice(1) : args
}

function getTmuxCommand(args: string[]): string {
  return normalizeParsedTmuxArgs(args)[0] ?? ''
}

function getTmuxFormatArg(args: string[]): string {
  const normalizedArgs = normalizeParsedTmuxArgs(args)
  const formatIndex = normalizedArgs.indexOf('-F')
  return formatIndex >= 0 ? normalizedArgs[formatIndex + 1] ?? '' : ''
}

function buildTmuxRow(fields: Array<string | number>): string {
  return fields.map(String).join(TMUX_FIELD_SEPARATOR)
}

function createTmuxRunner(sessions: SessionState[], baseIndex = 0) {
  const sessionMap = new Map<string, WindowState[]>(
    sessions.map((session) => [session.name, [...session.windows]])
  )
  const sessionGroups = new Map<string, string>(
    sessions.map((session) => [session.name, session.group ?? session.name])
  )
  const calls: string[][] = []

  const normalizeTarget = (targetName: string): string =>
    targetName.startsWith('=') ? targetName.slice(1) : targetName

  const resolveGroup = (targetName: string): string | undefined =>
    sessionGroups.get(normalizeTarget(targetName)) ??
    (Array.from(sessionGroups.values()).includes(normalizeTarget(targetName))
      ? normalizeTarget(targetName)
      : undefined)

  const groupWindows = (sessionName: string): WindowState[] => {
    const group = resolveGroup(sessionName)
    if (!group) {
      return []
    }

    for (const [name, windows] of sessionMap.entries()) {
      if (sessionGroups.get(name) === group) {
        return windows
      }
    }
    return []
  }

  const runTmux = (args: string[]) => {
    calls.push(args)
    const normalizedArgs = normalizeParsedTmuxArgs(args)
    const command = normalizedArgs[0]

    if (command === 'has-session') {
      // tmux `-t =name` forces exact session-name match. Strip the prefix so
      // the mock matches the real tmux behavior of resolving the name.
      const rawTarget = normalizedArgs[2] ?? ''
      const exact = rawTarget.startsWith('=')
      const sessionName = exact ? rawTarget.slice(1) : rawTarget
      const exists = exact
        ? sessionMap.has(sessionName)
        : sessionMap.has(sessionName) ||
          Array.from(sessionMap.keys()).some((name) => name.startsWith(sessionName)) ||
          resolveGroup(sessionName) === sessionName
      if (exists) {
        return ''
      }
      throw new Error(`session not found: ${sessionName}`)
    }

    if (command === 'new-session') {
      // Parse: new-session -d -s <session> [-n <name>] [-c <path>] [command]
      const sIdx = normalizedArgs.indexOf('-s')
      const sessionName = sIdx >= 0 ? normalizedArgs[sIdx + 1] ?? '' : ''
      const tIdx = normalizedArgs.indexOf('-t')
      const targetName = tIdx >= 0 ? normalizedArgs[tIdx + 1] ?? '' : ''
      const nIdx = normalizedArgs.indexOf('-n')
      const windowName = nIdx >= 0 ? normalizedArgs[nIdx + 1] ?? '' : ''
      const cIdx = normalizedArgs.indexOf('-c')
      const windowPath = cIdx >= 0 ? normalizedArgs[cIdx + 1] ?? '' : ''

      // Everything after the last known flag/value is the shell command
      const flagPositions = [
        sIdx,
        sIdx + 1,
        tIdx,
        tIdx + 1,
        nIdx,
        nIdx + 1,
        cIdx,
        cIdx + 1,
      ]
        .filter((i) => i >= 0 && i < normalizedArgs.length)
      const maxFlagPos = Math.max(0, ...flagPositions)
      // Also skip -d which doesn't take a value
      const startCommand = normalizedArgs
        .slice(maxFlagPos + 1)
        .filter((a) => a !== '-d')
        .join(' ')

      const targetGroup = resolveGroup(targetName)
      const windows: WindowState[] = targetGroup ? groupWindows(targetName) : []
      if (windowName) {
        windows.push({
          id: '0',
          index: 0,
          name: windowName,
          path: windowPath,
          activity: 0,
          command: startCommand,
        })
      }
      sessionMap.set(sessionName, windows)
      sessionGroups.set(sessionName, targetGroup ?? sessionName)
      return ''
    }

    if (command === 'list-sessions') {
      const format = getTmuxFormatArg(normalizedArgs)
      if (format.includes('#{session_group}')) {
        return Array.from(sessionMap.keys())
          .map((sessionName) =>
            buildTmuxRow([sessionName, sessionGroups.get(sessionName) ?? sessionName])
          )
          .join('\n')
      }
      return Array.from(sessionMap.keys()).join('\n')
    }

    if (command === 'show-options') {
      return String(baseIndex)
    }

    if (command === 'list-windows') {
      const sessionName = normalizedArgs[2]
      const format = normalizedArgs[4]
      const windows = groupWindows(sessionName)
      if (format === '#{window_index}') {
        return windows.map((window) => String(window.index)).join('\n')
      }
      return windows
        .map(
          (window) => buildTmuxRow([
            window.id,
            window.name,
            window.path,
            window.activity,
            window.creation ?? window.activity,
            window.command,
          ])
        )
        .join('\n')
    }

    if (command === 'new-window') {
      const target = normalizedArgs[2]
      const name = normalizedArgs[4]
      const cwd = normalizedArgs[6]
      const startCommand = normalizedArgs[7]
      const [sessionName, indexText] = target.split(':')
      const index = Number.parseInt(indexText ?? '', 10)
      const windows = groupWindows(sessionName)
      windows.push({
        id: String(index),
        index,
        name,
        path: cwd,
        activity: 0,
        command: startCommand ?? '',
      })
      sessionMap.set(sessionName, windows)
      return ''
    }

    if (command === 'rename-window') {
      const target = normalizedArgs[2]
      const newName = normalizedArgs[3]
      const [sessionName, windowId] = target.split(':')
      const windows = groupWindows(sessionName)
      const window = windows.find((item) => item.id === windowId)
      if (window) {
        window.name = newName
      }
      return ''
    }

    if (command === 'kill-window') {
      const target = normalizedArgs[2]
      const [sessionName, windowId] = target.split(':')
      const windows = groupWindows(sessionName)
      sessionMap.set(
        sessionName,
        windows.filter((item) => item.id !== windowId)
      )
      return ''
    }

    if (command === 'display-message') {
      const targetIndex = normalizedArgs.indexOf('-t')
      const target =
        targetIndex >= 0 ? normalizedArgs[targetIndex + 1] ?? '' : ''
      const format = normalizedArgs[normalizedArgs.length - 1] ?? ''
      const [sessionName, windowId] = target.split(':')
      if (!sessionName) {
        return ''
      }
      if (format === '#{session_name}') {
        return sessionName
      }
      if (format.includes('#{window_name}') && format.includes('#{pane_current_path}')) {
        const window = groupWindows(sessionName).find(
          (item) => item.id === windowId || String(item.index) === windowId
        )
        if (!window) {
          return ''
        }
        return buildTmuxRow([window.name, window.path])
      }
      return sessionName
    }

    if (command === 'set-option') {
      // Handle set-option commands (e.g., mouse mode)
      return ''
    }

    throw new Error(`Unhandled tmux command: ${args.join(' ')}`)
  }

  return { runTmux, calls, sessionMap }
}

function makePaneCapture(content: string, width = 80, height = 24) {
  return { content, width, height }
}

describe('SessionManager', () => {
  test('listWindows keeps lastActivity stable until content changes', () => {
    const sessionName = 'agentboard-last-activity'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const contentSequences = new Map<string, string[]>([
      [`${sessionName}:1`, ['same', 'same', 'changed']],
    ])
    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = contentSequences.get(tmuxWindow) ?? ['']
      const next = sequence.shift() ?? ''
      contentSequences.set(tmuxWindow, sequence)
      return makePaneCapture(next)
    }

    let now = 1700000000000
    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => now,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const first = manager.listWindows()[0]
      now += 60000
      const second = manager.listWindows()[0]
      now += 60000
      const third = manager.listWindows()[0]

      expect(first?.status).toBe('waiting')
      expect(second?.status).toBe('waiting')
      expect(third?.status).toBe('working')
      expect(first?.lastActivity).toBe(second?.lastActivity)
      expect(third?.lastActivity).not.toBe(second?.lastActivity)
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows skips grace-period working on first observation', () => {
    const sessionName = 'agentboard-first-observation'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const contentSequences = new Map<string, string[]>([
      [`${sessionName}:1`, ['same', 'same']],
    ])
    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = contentSequences.get(tmuxWindow) ?? ['']
      const next = sequence.shift() ?? ''
      contentSequences.set(tmuxWindow, sequence)
      return makePaneCapture(next)
    }

    let now = 1700000000000
    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => now,
    })

    const originalPrefixes = config.discoverPrefixes
    const originalGrace = config.workingGracePeriodMs
    config.discoverPrefixes = []
    config.workingGracePeriodMs = 4000
    try {
      const first = manager.listWindows()[0]
      now += Math.max(1, Math.floor(config.workingGracePeriodMs / 2))
      const second = manager.listWindows()[0]

      expect(first?.status).toBe('waiting')
      expect(second?.status).toBe('waiting')
      expect(first?.lastActivity).toBe(second?.lastActivity)
    } finally {
      config.discoverPrefixes = originalPrefixes
      config.workingGracePeriodMs = originalGrace
    }
  })

  test('listWindows ignores resize-only changes and detects real changes', () => {
    const sessionName = 'agentboard-resize-detection'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const wideBorderTop = '\u250c\u2500\u2500\u2500\u2500\u2510'
    const wideBorderBottom = '\u2514\u2500\u2500\u2500\u2500\u2518'
    const narrowBorderTop = '\u250c\u2500\u2510'
    const narrowBorderBottom = '\u2514\u2500\u2518'

    const captures = new Map<string, ReturnType<typeof makePaneCapture>[]>([
      [
        `${sessionName}:1`,
        [
          makePaneCapture(
            [wideBorderTop, 'Hello   world', wideBorderBottom].join('\n'),
            120,
            40
          ),
          makePaneCapture(
            [narrowBorderTop, 'Hello world', narrowBorderBottom].join('\n'),
            80,
            24
          ),
          makePaneCapture(
            [narrowBorderTop, 'Hello there', narrowBorderBottom].join('\n'),
            80,
            24
          ),
        ],
      ],
    ])

    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = captures.get(tmuxWindow) ?? []
      const next = sequence.shift() ?? null
      captures.set(tmuxWindow, sequence)
      return next
    }

    let now = 1700000000000
    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => now,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const first = manager.listWindows()[0]
      now += 60000
      const second = manager.listWindows()[0]
      now += 60000
      const third = manager.listWindows()[0]

      expect(first?.status).toBe('waiting')
      expect(second?.status).toBe('waiting')
      expect(third?.status).toBe('working')
      expect(first?.lastActivity).toBe(second?.lastActivity)
      expect(third?.lastActivity).not.toBe(second?.lastActivity)
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows ignores metadata changes during resize', () => {
    const sessionName = 'agentboard-resize-metadata'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const captures = new Map<string, ReturnType<typeof makePaneCapture>[]>([
      [
        `${sessionName}:1`,
        [
          makePaneCapture(
            [
              'Output line',
              '89% context left · ? for shortcuts',
              '1 background terminal running · /ps to view',
            ].join('\n'),
            120,
            40
          ),
          makePaneCapture(
            ['Output line', '88% context left · ? for shortcuts'].join('\n'),
            80,
            24
          ),
        ],
      ],
    ])

    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = captures.get(tmuxWindow) ?? []
      const next = sequence.shift() ?? null
      captures.set(tmuxWindow, sequence)
      return next
    }

    let now = 1700000000000
    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => now,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const first = manager.listWindows()[0]
      now += 60000
      const second = manager.listWindows()[0]

      expect(first?.status).toBe('waiting')
      expect(second?.status).toBe('waiting')
      expect(first?.lastActivity).toBe(second?.lastActivity)
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows returns permission for prompt content', () => {
    const sessionName = 'agentboard-permission'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const captures = new Map<string, ReturnType<typeof makePaneCapture>[]>([
      [
        `${sessionName}:1`,
        [
          makePaneCapture('Do you want to proceed?\n1. Yes\n2. No', 120, 40),
          makePaneCapture('Do you want to proceed?\n1. Yes\n2. No', 80, 24),
        ],
      ],
    ])

    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = captures.get(tmuxWindow) ?? []
      const next = sequence.shift() ?? null
      captures.set(tmuxWindow, sequence)
      return next
    }

    let now = 1700000000000
    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => now,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const first = manager.listWindows()[0]
      now += 60000
      const second = manager.listWindows()[0]

      expect(first?.status).toBe('permission')
      expect(second?.status).toBe('permission')
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows updates status based on pane content changes', () => {
    const managedSession = 'agentboard'
    const externalSession = 'external-1'
    const runner = createTmuxRunner(
      [
        {
          name: managedSession,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 1700000000,
              command: 'claude',
            },
          ],
        },
        {
          name: externalSession,
          windows: [
            {
              id: '2',
              index: 2,
              name: 'bravo',
              path: '/tmp/bravo',
              activity: 1700000001,
              command: 'codex',
            },
          ],
        },
      ],
      1
    )

    const contentSequences = new Map<string, string[]>([
      [`${managedSession}:1`, ['same', 'same']],
      [`${externalSession}:2`, ['first', 'second']],
    ])

    const capturePaneContent = (tmuxWindow: string) => {
      const sequence = contentSequences.get(tmuxWindow) ?? ['']
      const next = sequence.shift() ?? ''
      contentSequences.set(tmuxWindow, sequence)
      return makePaneCapture(next)
    }

    // Advance time past grace period between calls to trigger "waiting" on unchanged content
    let currentTime = 1700000000000
    const manager = new SessionManager(managedSession, {
      runTmux: runner.runTmux,
      capturePaneContent,
      now: () => currentTime,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = ['external-']
    try {
      const first = manager.listWindows()
      currentTime += 5000 // Advance past grace period (4000ms)
      const second = manager.listWindows()

      const firstManaged = first.find((session) => session.tmuxWindow === `${managedSession}:1`)
      const secondManaged = second.find((session) => session.tmuxWindow === `${managedSession}:1`)
      const secondExternal = second.find((session) => session.tmuxWindow === `${externalSession}:2`)

      expect(firstManaged?.status).toBe('waiting')
      expect(secondManaged?.status).toBe('waiting')
      expect(secondExternal?.status).toBe('working')
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows discovers external sessions when prefixes are unset', () => {
    const managedSession = 'agentboard'
    const externalSession = 'work'
    const wsSession = `${managedSession}-ws-orphan`
    const runner = createTmuxRunner(
      [
        {
          name: managedSession,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
        {
          name: externalSession,
          windows: [
            {
              id: '2',
              index: 2,
              name: 'bravo',
              path: '/tmp/bravo',
              activity: 0,
              command: 'codex',
            },
          ],
        },
        {
          name: wsSession,
          windows: [
            {
              id: '9',
              index: 9,
              name: 'ws',
              path: '/tmp/ws',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(managedSession, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const sessions = manager.listWindows()
      const managed = sessions.find(
        (session) => session.tmuxWindow === `${managedSession}:1`
      )
      const external = sessions.find(
        (session) => session.tmuxWindow === `${externalSession}:2`
      )
      const ws = sessions.find(
        (session) => session.tmuxWindow === `${wsSession}:9`
      )

      expect(managed?.source).toBe('managed')
      expect(external?.source).toBe('external')
      expect(ws).toBeUndefined()
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows hides reserved bootstrap window only in the managed base session', () => {
    const managedSession = 'agentboard-bootstrap-filter'
    const externalSession = 'work-bootstrap-filter'
    const runner = createTmuxRunner(
      [
        {
          name: managedSession,
          windows: [
            {
              id: '0',
              index: 0,
              name: BOOTSTRAP_WINDOW_NAME,
              path: '/tmp/managed',
              activity: 0,
              command: BOOTSTRAP_WINDOW_COMMAND,
            },
            {
              id: '1',
              index: 1,
              name: BOOTSTRAP_WINDOW_NAME,
              path: '/tmp/manual',
              activity: 0,
              command: 'claude',
            },
          ],
        },
        {
          name: externalSession,
          windows: [
            {
              id: '1',
              index: 1,
              name: BOOTSTRAP_WINDOW_NAME,
              path: '/tmp/external',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(managedSession, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const sessions = manager.listWindows()

      expect(
        sessions.find((session) => session.tmuxWindow === `${managedSession}:0`)
      ).toBeUndefined()
      expect(
        sessions.find((session) => session.tmuxWindow === `${externalSession}:1`)
      ).toBeTruthy()
      expect(
        sessions.find((session) => session.tmuxWindow === `${managedSession}:1`)
      ).toBeUndefined()
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows falls back when tmux format keys are missing', () => {
    const sessionName = 'agentboard-format-fallback'
    const calls: string[][] = []

    const runTmux = (args: string[]) => {
      calls.push(args)
      const command = getTmuxCommand(args)

      if (command === 'has-session') {
        return ''
      }

      if (command === 'list-sessions') {
        return sessionName
      }

      if (command === 'list-windows') {
        const format = getTmuxFormatArg(args)
        if (
          format.includes('window_creation_time') ||
          format.includes('pane_start_command')
        ) {
          throw new Error('unknown format: window_creation_time')
        }
        return [
          buildTmuxRow([
            '0',
            BOOTSTRAP_WINDOW_NAME,
            '/tmp/bootstrap',
            '1700000000',
            '1700000000',
            'tail',
          ]),
          buildTmuxRow([
            '1',
            'alpha',
            '/tmp/alpha',
            '1700000000',
            '1700000000',
            'claude',
          ]),
        ].join('\n')
      }

      if (command === 'set-option') {
        return ''
      }

      throw new Error(`Unhandled tmux command: ${args.join(' ')}`)
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      now: () => 1700000000000,
    })

    const sessions = manager.listWindows()

    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.tmuxWindow).toBe(`${sessionName}:1`)
    expect(sessions[0]?.command).toBe('claude')
    expect(
      calls.some(
        (call) =>
          getTmuxCommand(call) === 'list-windows' &&
          getTmuxFormatArg(call).includes('window_creation_time')
      )
    ).toBe(true)
    expect(
      calls.some(
        (call) =>
          getTmuxCommand(call) === 'list-windows' &&
          getTmuxFormatArg(call).includes('pane_current_command')
      )
    ).toBe(true)
  })

  test('createWindow normalizes name and picks next index', () => {
    const sessionName = 'agentboard'
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'My-Project',
              path: tempDir,
              activity: 1700000000,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const created = manager.createWindow(tempDir, 'My Project', 'codex')
    expect(created.name).toBe('My-Project-2')
    expect(created.tmuxWindow).toBe(`${sessionName}:2`)
    expect(created.command).toBe('codex')

    const newWindowCall = runner.calls.find((call) => call[0] === 'new-window')
    expect(newWindowCall).toBeTruthy()
    expect(newWindowCall?.includes('My-Project-2')).toBe(true)
  })

  test('createWindow rejects missing or empty project paths', () => {
    const sessionName = 'agentboard-invalid-path'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    expect(() => manager.createWindow('   ')).toThrow('Project path is required')

    const missingPath = path.join(
      os.tmpdir(),
      `agentboard-missing-${Date.now()}`
    )
    expect(() => manager.createWindow(missingPath)).toThrow(
      `Project path does not exist: ${missingPath}`
    )
  })

  test('createWindow rejects the reserved bootstrap window name', () => {
    const sessionName = 'agentboard-reserved-create'
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    try {
      expect(() =>
        manager.createWindow(tempDir, BOOTSTRAP_WINDOW_NAME, 'claude')
      ).toThrow(/reserved/)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('renameWindow rejects duplicates and applies rename', () => {
    const sessionName = 'agentboard'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: '',
            },
            {
              id: '2',
              index: 2,
              name: 'bravo',
              path: '/tmp/bravo',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    expect(() => manager.renameWindow(`${sessionName}:1`, 'bravo')).toThrow(
      /already exists/
    )

    manager.renameWindow(`${sessionName}:1`, 'new_name')
    const renameCall = runner.calls.find((call) => call[0] === 'rename-window')
    expect(renameCall).toBeTruthy()
    expect(renameCall?.[3]).toBe('new_name')
  })

  test('renameWindow rejects invalid names', () => {
    const sessionName = 'agentboard-invalid-name'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    expect(() => manager.renameWindow(`${sessionName}:1`, 'bad name')).toThrow(
      /letters, numbers/
    )
    expect(() => manager.renameWindow(`${sessionName}:1`, '   ')).toThrow(
      /empty/
    )

    const renameCalls = runner.calls.filter((call) => call[0] === 'rename-window')
    expect(renameCalls).toHaveLength(0)
  })

  test('renameWindow rejects the reserved bootstrap window name', () => {
    const sessionName = 'agentboard-reserved-rename'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    expect(() =>
      manager.renameWindow(`${sessionName}:1`, BOOTSTRAP_WINDOW_NAME)
    ).toThrow(/reserved/)
  })

  test('killWindow sends tmux command', () => {
    const sessionName = 'agentboard-kill'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
    })

    manager.killWindow(`${sessionName}:1`)
    const killCall = runner.calls.find((call) => call[0] === 'kill-window')
    expect(killCall).toEqual(['kill-window', '-t', `${sessionName}:1`])
  })

  test('setWindowOption sends tmux set-option -w command', () => {
    const sessionName = 'agentboard-setopt'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: '',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
    })

    manager.setWindowOption(`${sessionName}:1`, 'remain-on-exit', 'failed')
    const setOptCall = runner.calls.find((call) => call[0] === 'set-option' && call[1] === '-w')
    expect(setOptCall).toEqual(['set-option', '-w', '-t', `${sessionName}:1`, 'remain-on-exit', 'failed'])
  })

  test('setWindowOption applies the configured mutation timeout to tmux writes', () => {
    const spawnCalls: Array<{ args: string[]; timeout?: number }> = []
    bunAny.spawnSync = ((args, options) => {
      spawnCalls.push({
        args: Array.isArray(args) ? [...args] : [],
        timeout:
          typeof options === 'object' && options !== null && 'timeout' in options
            ? (options.timeout as number | undefined)
            : undefined,
      })
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const manager = new SessionManager('agentboard-default-timeout')
      manager.setWindowOption('agentboard-default-timeout:1', 'remain-on-exit', 'failed')

      expect(spawnCalls[0]?.args).toEqual([
        'tmux',
        'set-option',
        '-w',
        '-t',
        'agentboard-default-timeout:1',
        'remain-on-exit',
        'failed',
      ])
      expect(spawnCalls[0]?.timeout).toBe(config.tmuxMutationTimeoutMs)
    } finally {
      bunAny.spawnSync = originalSpawnSync
    }
  })

  test('setMouseMode applies base session updates with the mutation timeout and no preflight probe', () => {
    const sessionName = 'agentboard-setmouse-timeout'
    const spawnCalls: Array<{ args: string[]; timeout?: number }> = []
    bunAny.spawnSync = ((args, options) => {
      spawnCalls.push({
        args: Array.isArray(args) ? [...args] : [],
        timeout:
          typeof options === 'object' && options !== null && 'timeout' in options
            ? (options.timeout as number | undefined)
            : undefined,
      })

      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    try {
      const manager = new SessionManager(sessionName, {
        capturePaneContent: () => null,
        mouseMode: true,
      })

      manager.setMouseMode(false)

      expect(spawnCalls.some((call) => call.args[1] === 'has-session')).toBe(false)
      expect(spawnCalls[0]).toEqual({
        args: ['tmux', 'set-option', '-t', sessionName, 'mouse', 'off'],
        timeout: config.tmuxMutationTimeoutMs,
      })
    } finally {
      bunAny.spawnSync = originalSpawnSync
    }
  })

  test('listWindows uses default capturePaneContent on success', () => {
    const sessionName = 'agentboard-default-capture'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 1700000000,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    bunAny.spawnSync = (args) => {
      const command = Array.isArray(args) ? getTmuxCommand(args.slice(1)) : ''
      if (command === 'display-message') {
        return {
          exitCode: 0,
          stdout: Buffer.from(buildTmuxRow([80, 24])),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from('content'),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }

    try {
      const manager = new SessionManager(sessionName, {
        runTmux: runner.runTmux,
        now: () => 1700000000000,
      })

      const sessions = manager.listWindows()
      expect(sessions[0]?.status).toBe('waiting')
    } finally {
      bunAny.spawnSync = originalSpawnSync
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows returns unknown when capturePaneContent fails', () => {
    const sessionName = 'agentboard-error-capture'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 1700000000,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    bunAny.spawnSync = () =>
      ({
        exitCode: 1,
        stdout: Buffer.from(''),
        stderr: Buffer.from('error'),
      }) as ReturnType<typeof Bun.spawnSync>

    try {
      const manager = new SessionManager(sessionName, {
        runTmux: runner.runTmux,
        now: () => 1700000000000,
      })

      const sessions = manager.listWindows()
      expect(sessions[0]?.status).toBe('unknown')
    } finally {
      bunAny.spawnSync = originalSpawnSync
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows handles capturePaneContent exceptions', () => {
    const sessionName = 'agentboard-throw-capture'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 1700000000,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    bunAny.spawnSync = () => {
      throw new Error('boom')
    }

    try {
      const manager = new SessionManager(sessionName, {
        runTmux: runner.runTmux,
        now: () => 1700000000000,
      })

      const sessions = manager.listWindows()
      expect(sessions[0]?.status).toBe('unknown')
    } finally {
      bunAny.spawnSync = originalSpawnSync
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows detects agent type from commands with flags', () => {
    const sessionName = 'agentboard-agent-type'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            { id: '1', index: 1, name: 'a', path: '/tmp', activity: 0, command: 'codex --search' },
            { id: '2', index: 2, name: 'b', path: '/tmp', activity: 0, command: 'claude --help' },
            { id: '3', index: 3, name: 'c', path: '/tmp', activity: 0, command: '/usr/local/bin/codex' },
            { id: '4', index: 4, name: 'd', path: '/tmp', activity: 0, command: 'npx codex' },
            { id: '5', index: 5, name: 'e', path: '/tmp', activity: 0, command: 'ENV_VAR=1 claude' },
            { id: '6', index: 6, name: 'f', path: '/tmp', activity: 0, command: 'bash' },
            { id: '7', index: 7, name: 'g', path: '/tmp', activity: 0, command: '"codex --search"' },
            { id: '8', index: 8, name: 'h', path: '/tmp', activity: 0, command: "'claude --dangerously-skip-permissions'" },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const sessions = manager.listWindows()
      const byName = (name: string) => sessions.find((s) => s.name === name)

      expect(byName('a')?.agentType).toBe('codex')
      expect(byName('b')?.agentType).toBe('claude')
      expect(byName('c')?.agentType).toBe('codex')
      expect(byName('d')?.agentType).toBe('codex')
      expect(byName('e')?.agentType).toBe('claude')
      expect(byName('f')?.agentType).toBeUndefined()
      expect(byName('g')?.agentType).toBe('codex')
      expect(byName('h')?.agentType).toBe('claude')
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows returns empty when session does not exist (no orphan shell window)', () => {
    const sessionName = 'agentboard-fresh-boot'
    // Session does NOT exist in tmux — simulates a fresh reboot
    const runner = createTmuxRunner([], 0)

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => null,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const sessions = manager.listWindows()
      expect(sessions).toEqual([])

      // Should NOT have called new-session (the old bug)
      const newSessionCalls = runner.calls.filter(
        (call) => getTmuxCommand(call) === 'new-session'
      )
      expect(newSessionCalls.length).toBe(0)
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('listWindows returns empty when tmux socket is unavailable', () => {
    const sessionName = 'agentboard-no-socket'
    const runTmux = (args: string[]) => {
      const command = normalizeParsedTmuxArgs(args)[0]
      if (command === 'has-session') {
        throw new Error(
          'error connecting to /private/tmp/tmux-501/missing (No such file or directory)'
        )
      }
      if (command === 'list-sessions') {
        return ''
      }
      return ''
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      expect(manager.listWindows()).toEqual([])
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('createWindow uses new-session when session does not exist', () => {
    const sessionName = 'agentboard-first-window'
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    // Session does NOT exist — simulates first window creation after reboot
    const runner = createTmuxRunner([], 0)

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const created = manager.createWindow(tempDir, 'my-project', 'claude')

    // Should have used new-session (not new-window) to avoid orphan shell
    const newSessionCalls = runner.calls.filter(
      (call) => getTmuxCommand(call) === 'new-session'
    )
    expect(newSessionCalls.length).toBe(1)
    expect(newSessionCalls[0]).toContain(sessionName)
    expect(newSessionCalls[0]).toContain('my-project')
    expect(newSessionCalls[0]).toContain('claude')

    // Should NOT have called new-window
    const newWindowCalls = runner.calls.filter(
      (call) => getTmuxCommand(call) === 'new-window'
    )
    expect(newWindowCalls.length).toBe(0)

    // Created session should have exactly one window — no orphan shell
    expect(created.name).toBe('my-project')
    expect(created.command).toBe('claude')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('createWindow uses new-window when session already exists', () => {
    const sessionName = 'agentboard-existing'
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const runner = createTmuxRunner(
      [{ name: sessionName, windows: [
        { id: '0', index: 0, name: 'existing', path: tempDir, activity: 0, command: 'claude' },
      ] }],
      0
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const created = manager.createWindow(tempDir, 'second', 'codex')

    // Should have used new-window (session already exists)
    const newWindowCalls = runner.calls.filter(
      (call) => getTmuxCommand(call) === 'new-window'
    )
    expect(newWindowCalls.length).toBe(1)

    // Should NOT have called new-session
    const newSessionCalls = runner.calls.filter(
      (call) => getTmuxCommand(call) === 'new-session'
    )
    expect(newSessionCalls.length).toBe(0)

    expect(created.name).toBe('second')
    expect(created.command).toBe('codex')

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('listWindows strips tmux double-quotes from pane_start_command', () => {
    const sessionName = 'agentboard-quote-strip'
    const runner = createTmuxRunner(
      [
        {
          name: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'quoted',
              path: '/tmp/quoted',
              activity: 0,
              command: '"claude --dangerously-skip-permissions"',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const originalPrefixes = config.discoverPrefixes
    config.discoverPrefixes = []
    try {
      const sessions = manager.listWindows()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.command).toBe('claude --dangerously-skip-permissions')
    } finally {
      config.discoverPrefixes = originalPrefixes
    }
  })

  test('mouse mode can be disabled via constructor option', () => {
    const sessionName = 'agentboard-mouse-test'
    const runner = createTmuxRunner(
      [{ name: sessionName, windows: [] }],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => null,
      mouseMode: false,
    })

    manager.listWindows() // Triggers ensureSession

    // Should set mouse off when disabled
    const setOptionCall = runner.calls.find(
      (call) => call[0] === 'set-option' && call.includes('mouse')
    )
    expect(setOptionCall).toBeTruthy()
    expect(setOptionCall).toContain('off')
    expect(setOptionCall).toContain('-t')
    expect(setOptionCall).toContain(sessionName)
  })

  test('setMouseMode applies change immediately', () => {
    const sessionName = 'agentboard-setmouse-test'
    const runner = createTmuxRunner(
      [
        { name: sessionName, windows: [] },
        { name: `${sessionName}-ws-a`, windows: [] },
        { name: `${sessionName}-ws-b`, windows: [] },
        { name: 'other-session', windows: [] },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    manager.listWindows() // Triggers ensureSession with mouse on

    // Clear calls to track new calls
    runner.calls.length = 0

    // Toggle mouse mode off
    manager.setMouseMode(false)

    const mouseSetCalls = runner.calls.filter(
      (call) => call[0] === 'set-option' && call.includes('mouse')
    )
    expect(mouseSetCalls).toContainEqual([
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'off',
    ])
    expect(mouseSetCalls).toContainEqual([
      'set-option',
      '-t',
      `${sessionName}-ws-a`,
      'mouse',
      'off',
    ])
    expect(mouseSetCalls).toContainEqual([
      'set-option',
      '-t',
      `${sessionName}-ws-b`,
      'mouse',
      'off',
    ])
    expect(mouseSetCalls.some((call) => call.includes('other-session'))).toBe(
      false
    )
  })

  test('setMouseMode rethrows non-timeout base session failures', () => {
    const sessionName = 'agentboard-setmouse-error'
    const runTmux = (args: string[]) => {
      const command = normalizeParsedTmuxArgs(args)[0]
      if (command === 'set-option') {
        throw new Error('set-option failed')
      }
      if (command === 'list-sessions') {
        return sessionName
      }
      return ''
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).toThrow('set-option failed')
  })

  test('setMouseMode keeps previous in-memory value when apply fails', () => {
    const sessionName = 'agentboard-setmouse-rollback'
    const runner = createTmuxRunner([
      {
        name: sessionName,
        windows: [],
      },
    ])
    let firstSetOptionFailed = false
    const runTmux = (args: string[]) => {
      const normalized = normalizeParsedTmuxArgs(args)
      const command = normalized[0]
      if (
        command === 'set-option' &&
        !firstSetOptionFailed &&
        normalized[2] === sessionName
      ) {
        firstSetOptionFailed = true
        throw new Error('set-option failed')
      }
      return runner.runTmux(args)
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).toThrow('set-option failed')

    runner.calls.length = 0
    manager.listWindows()

    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'on',
    ])
  })

  test('setMouseMode ignores base session exit races', () => {
    const sessionName = 'agentboard-setmouse-race'
    const runTmux = (args: string[]) => {
      const command = normalizeParsedTmuxArgs(args)[0]
      if (command === 'set-option') {
        throw new Error(`can't find session: ${sessionName}`)
      }
      if (command === 'list-sessions') {
        return ''
      }
      return ''
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).not.toThrow()
  })

  test('setMouseMode ignores missing tmux socket errors', () => {
    const sessionName = 'agentboard-setmouse-no-socket'
    const runTmux = (args: string[]) => {
      const command = normalizeParsedTmuxArgs(args)[0]
      if (command === 'set-option' || command === 'list-sessions') {
        throw new Error(
          'error connecting to /private/tmp/tmux-501/missing (No such file or directory)'
        )
      }
      return ''
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).not.toThrow()
  })

  test('setMouseMode throws and rolls back when grouped session sync fails', () => {
    const sessionName = 'agentboard-setmouse-grouped'
    const runner = createTmuxRunner([
      {
        name: sessionName,
        windows: [],
      },
      {
        name: `${sessionName}-ws-a`,
        windows: [],
      },
      {
        name: `${sessionName}-ws-b`,
        windows: [],
      },
    ])
    let groupedFailureInjected = false
    const runTmux = (args: string[]) => {
      const normalized = normalizeParsedTmuxArgs(args)
      if (
        normalized[0] === 'set-option' &&
        normalized[2] === `${sessionName}-ws-b` &&
        !groupedFailureInjected
      ) {
        groupedFailureInjected = true
        throw new Error('grouped set-option failed')
      }
      return runner.runTmux(args)
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).toThrow('grouped set-option failed')
    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'off',
    ])
    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      `${sessionName}-ws-a`,
      'mouse',
      'off',
    ])
    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      `${sessionName}-ws-a`,
      'mouse',
      'on',
    ])
    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'on',
    ])

    runner.calls.length = 0
    manager.listWindows()

    expect(runner.calls).toContainEqual([
      'set-option',
      '-t',
      sessionName,
      'mouse',
      'on',
    ])
  })

  test('setMouseMode throws and rolls back when grouped session discovery fails', () => {
    const sessionName = 'agentboard-setmouse-discovery'
    let setOptionCount = 0
    let failDiscovery = true
    const runTmux = (args: string[]) => {
      const normalized = normalizeParsedTmuxArgs(args)
      if (normalized[0] === 'set-option') {
        setOptionCount += 1
        return ''
      }
      if (normalized[0] === 'list-sessions') {
        if (failDiscovery) {
          throw new TmuxTimeoutError('list-sessions', 3000)
        }
        return ''
      }
      if (normalized[0] === 'list-windows') {
        return ''
      }
      return ''
    }

    const manager = new SessionManager(sessionName, {
      runTmux,
      capturePaneContent: () => null,
      mouseMode: true,
    })

    expect(() => manager.setMouseMode(false)).toThrow(TmuxTimeoutError)
    expect(setOptionCount).toBe(2)

    setOptionCount = 0
    failDiscovery = false
    manager.ensureSession()
    expect(setOptionCount).toBe(1)
  })

  test('ensureSession rejoins an existing tmux session group', () => {
    const sessionName = 'agentboard-rejoin-group'
    const wsSession = `${sessionName}-ws-existing`
    const runner = createTmuxRunner(
      [
        {
          name: wsSession,
          group: sessionName,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'alpha',
              path: '/tmp/alpha',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const result = manager.ensureSession()

    expect(runner.calls).toContainEqual([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-t',
      `=${wsSession}`,
    ])
    expect(
      runner.calls.some(
        (call) =>
          getTmuxCommand(call) === 'new-session' &&
          call.includes(BOOTSTRAP_WINDOW_NAME)
      )
    ).toBe(false)
    expect(result.canPruneWsSessions).toBe(true)

    const sessions = manager.listWindows()
    expect(sessions.find((session) => session.name === 'alpha')).toBeTruthy()
  })

  test('ensureSession does not rejoin unrelated sessions with matching prefixes', () => {
    const sessionName = 'agentboard-prefix'
    const unrelatedSession = `${sessionName}-work`
    const runner = createTmuxRunner(
      [
        {
          name: unrelatedSession,
          windows: [
            {
              id: '1',
              index: 1,
              name: 'external',
              path: '/tmp/external',
              activity: 0,
              command: 'claude',
            },
          ],
        },
      ],
      1
    )

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const result = manager.ensureSession()

    expect(runner.calls).toContainEqual([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      BOOTSTRAP_WINDOW_NAME,
      'tail -f /dev/null',
    ])
    expect(
      runner.calls.some(
        (call) =>
          getTmuxCommand(call) === 'new-session' &&
          call.includes('-t')
      )
    ).toBe(false)
    expect(result.canPruneWsSessions).toBe(true)
  })

  test('ensureSession creates bootstrap session when session_group format is unavailable', () => {
    const sessionName = 'agentboard-no-session-group-format'
    const runTmux = (args: string[]) => {
      const normalized = normalizeParsedTmuxArgs(args)
      if (normalized[0] === 'has-session') {
        throw new Error(`can't find session: ${sessionName}`)
      }
      if (
        normalized[0] === 'list-sessions' &&
        getTmuxFormatArg(normalized).includes('#{session_group}')
      ) {
        throw new Error('unknown variable: session_group')
      }
      return ''
    }
    const calls: string[][] = []
    const manager = new SessionManager(sessionName, {
      runTmux: (args) => {
        calls.push(args)
        return runTmux(args)
      },
      capturePaneContent: () => makePaneCapture(''),
      now: () => 1700000000000,
    })

    const result = manager.ensureSession()

    expect(calls).toContainEqual([
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      BOOTSTRAP_WINDOW_NAME,
      BOOTSTRAP_WINDOW_COMMAND,
    ])
    expect(result.canPruneWsSessions).toBe(false)
  })

  test('listWindows preserves lastActivity when pane capture times out', () => {
    const sessionName = 'agentboard-capture-timeout'
    const runner = createTmuxRunner([
      {
        name: sessionName,
        windows: [
          {
            id: '1',
            index: 1,
            name: 'alpha',
            path: '/tmp/project',
            activity: 0,
            creation: 0,
            command: 'codex',
          },
        ],
      },
    ])
    const captureSequence = [makePaneCapture('idle'), null] as const
    let captureIndex = 0
    let nowValue = 1_700_000_000_000

    const manager = new SessionManager(sessionName, {
      runTmux: runner.runTmux,
      capturePaneContent: () => captureSequence[captureIndex++] ?? null,
      now: () => nowValue,
      mouseMode: true,
    })

    const first = manager.listWindows()[0]
    if (!first) {
      throw new Error('Expected first session')
    }

    nowValue += 5000
    const second = manager.listWindows()[0]
    if (!second) {
      throw new Error('Expected second session')
    }

    expect(second.status).toBe('waiting')
    expect(second.lastActivity).toBe(first.lastActivity)
  })
})
