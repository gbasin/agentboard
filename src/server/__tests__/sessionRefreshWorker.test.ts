import { afterEach, describe, expect, test } from 'bun:test'
import type { RefreshWorkerRequest, RefreshWorkerResponse } from '../sessionRefreshWorker'
import { TMUX_TIMEOUT_ERROR_CODE } from '../tmuxTimeout'
import {
  BOOTSTRAP_WINDOW_COMMAND,
  BOOTSTRAP_WINDOW_NAME,
  TMUX_FIELD_SEPARATOR,
} from '../tmuxFormat'
import type { Session } from '../../shared/types'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync

const globalAny = globalThis as unknown as {
  self?: DedicatedWorkerGlobalScope | undefined
}
const originalSelf = globalAny.self

let messages: RefreshWorkerResponse[] = []
let ctx: DedicatedWorkerGlobalScope
let closeCalls = 0

function joinTmuxFields(fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR)
}

function getTmuxSubcommand(args: string[]): string | undefined {
  if (args[0] !== 'tmux') {
    return undefined
  }
  return args[1] === '-u' ? args[2] : args[1]
}

async function loadWorker(tag: string) {
  messages = []
  closeCalls = 0
  ctx = {
    close: () => {
      closeCalls += 1
    },
    postMessage: (message: RefreshWorkerResponse) => {
      messages.push(message)
    },
  } as DedicatedWorkerGlobalScope
  globalAny.self = ctx
  await import(`../sessionRefreshWorker?${tag}`)
  if (!ctx.onmessage) {
    throw new Error('Worker did not register onmessage handler')
  }
  return ctx
}

function emitMessage(payload: RefreshWorkerRequest) {
  ctx.onmessage?.({ data: payload } as MessageEvent<RefreshWorkerRequest>)
}

function getLastResponse() {
  const response = messages[messages.length - 1]
  if (!response) {
    throw new Error('Missing worker response')
  }
  return response
}

afterEach(() => {
  bunAny.spawnSync = originalSpawnSync
  if (globalAny.self === ctx) {
    globalAny.self = originalSelf
  }
})

describe('sessionRefreshWorker', () => {
  test('refresh filters windows and infers session metadata', async () => {
    await loadWorker('refresh-filter')

    const listOutput = [
      joinTmuxFields(['agentboard', '1', 'alpha|||view', '/Users/test/project|||main', '100', '1700000000', 'codex --search', '80', '24']),
      joinTmuxFields(['agentboard', '5', BOOTSTRAP_WINDOW_NAME, '/Users/test/bootstrap', '100', '1700000004', BOOTSTRAP_WINDOW_COMMAND, '80', '24']),
      joinTmuxFields(['agentboard', '6', BOOTSTRAP_WINDOW_NAME, '/Users/test/manual', '100', '1700000005', 'claude', '80', '24']),
      joinTmuxFields(['agentboard-ws-foo', '2', 'ws', '/Users/test/ws', '100', '1700000001', 'bash', '80', '24']),
      joinTmuxFields(['external-|||session', '3', 'ext', '/Users/test/ext|||path', '100', '1700000002', 'claude', '100', '40']),
      joinTmuxFields(['other', '4', 'other', '/Users/test/other', '100', '1700000003', 'bash', '80', '24']),
    ].join('\n')

    const captureOutputs = new Map<string, string>([
      ['agentboard:1', 'ready'],
      ['agentboard:6', 'manual'],
      ['external-|||session:3', 'waiting'],
    ])

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'list-windows') {
        return {
          exitCode: 0,
          stdout: Buffer.from(listOutput),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (getTmuxSubcommand(args) === 'capture-pane') {
        const targetIndex = args.indexOf('-t')
        const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
        const output = captureOutputs.get(target ?? '')
        if (output === undefined) {
          return {
            exitCode: 1,
            stdout: Buffer.from(''),
            stderr: Buffer.from('missing'),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(output),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: '1',
      kind: 'refresh',
      managedSession: 'agentboard',
      discoverPrefixes: ['external-'],
    })

    const response = getLastResponse()
    if (response.type !== 'result' || response.kind !== 'refresh') {
      throw new Error('Unexpected response type')
    }

    expect(response.sessions).toHaveLength(2)

    const managed = response.sessions.find(
      (session) => session.tmuxWindow === 'agentboard:1'
    )
    const external = response.sessions.find(
      (session) => session.tmuxWindow === 'external-|||session:3'
    )
    const manualReservedName = response.sessions.find(
      (session) => session.tmuxWindow === 'agentboard:6'
    )

    expect(managed).toEqual(
      expect.objectContaining({
        name: 'alpha|||view',
        projectPath: '/Users/test/project|||main',
        source: 'managed',
        status: 'waiting',
        agentType: 'codex',
      })
    )
    expect(external).toEqual(
      expect.objectContaining({
        name: 'external-|||session',
        projectPath: '/Users/test/ext|||path',
        source: 'external',
        status: 'waiting',
        agentType: 'claude',
      })
    )
    expect(manualReservedName).toBeUndefined()
  })

  test('refresh normalizes tmux-quoted pane_start_command', async () => {
    await loadWorker('refresh-quoted-command')

    const listOutput = [
      joinTmuxFields(['agentboard', '1', 'alpha', '/Users/test/project', '100', '1700000000', '"claude --dangerously-skip-permissions"', '80', '24']),
    ].join('\n')

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'list-windows') {
        return {
          exitCode: 0,
          stdout: Buffer.from(listOutput),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (getTmuxSubcommand(args) === 'capture-pane') {
        return {
          exitCode: 0,
          stdout: Buffer.from('ready'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: '1',
      kind: 'refresh',
      managedSession: 'agentboard',
      discoverPrefixes: [],
    })

    const response = getLastResponse()
    if (response.type !== 'result' || response.kind !== 'refresh') {
      throw new Error('Unexpected response type')
    }

    expect(response.sessions).toHaveLength(1)
    expect(response.sessions[0]?.command).toBe('claude --dangerously-skip-permissions')
    expect(response.sessions[0]?.agentType).toBe('claude')
  })

  test('refresh falls back when tmux format is unsupported', async () => {
    await loadWorker('format-fallback')

    const listOutput = [
      joinTmuxFields(['agentboard', '0', BOOTSTRAP_WINDOW_NAME, '/Users/test/bootstrap', '100', '1700000000', 'tail', '80', '24']),
      joinTmuxFields(['agentboard', '1', 'alpha', '/Users/test/project', '100', '1700000000', 'codex', '80', '24']),
    ].join('\n')

    let listCalls = 0

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'list-windows') {
        listCalls += 1
        if (listCalls === 1) {
          return {
            exitCode: 1,
            stdout: Buffer.from(''),
            stderr: Buffer.from('unknown variable'),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(listOutput),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      if (getTmuxSubcommand(args) === 'capture-pane') {
        return {
          exitCode: 0,
          stdout: Buffer.from('ready'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: '1',
      kind: 'refresh',
      managedSession: 'agentboard',
      discoverPrefixes: [],
    })

    const response = getLastResponse()
    if (response.type !== 'result' || response.kind !== 'refresh') {
      throw new Error('Unexpected response type')
    }

    expect(response.sessions).toHaveLength(1)
    expect(response.sessions[0]?.tmuxWindow).toBe('agentboard:1')
    expect(listCalls).toBe(2)
  })

  test('last-user-message returns the latest prompt', async () => {
    await loadWorker('last-user-message')

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'capture-pane') {
        return {
          exitCode: 0,
          stdout: Buffer.from('❯ First message\nok\n❯ Second message\n'),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: '1',
      kind: 'last-user-message',
      tmuxWindow: 'agentboard:1',
    })

    const response = getLastResponse()
    if (response.type !== 'result' || response.kind !== 'last-user-message') {
      throw new Error('Unexpected response type')
    }

    expect(response.message).toBe('Second message')
  })

  test('last-user-message marks tmux timeouts with a structured error code', async () => {
    await loadWorker('last-user-message-timeout')

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'capture-pane') {
        return {
          exitCode: null,
          signalCode: 'SIGTERM',
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as unknown as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: 'timeout-last-user-message',
      kind: 'last-user-message',
      tmuxWindow: 'agentboard:1',
    })

    const response = getLastResponse()
    expect(response.type).toBe('error')
    if (response.type === 'error') {
      expect(response.errorCode).toBe(TMUX_TIMEOUT_ERROR_CODE)
      expect(response.error).toContain('timed out')
    }
  })

  test('refresh responds with error on tmux failure', async () => {
    await loadWorker('refresh-error')

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'list-windows') {
        return {
          exitCode: 1,
          stdout: Buffer.from(''),
          stderr: Buffer.from('boom'),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: '1',
      kind: 'refresh',
      managedSession: 'agentboard',
      discoverPrefixes: [],
    })

    const response = getLastResponse()
    expect(response.type).toBe('error')
    if (response.type === 'error') {
      expect(response.error).toContain('boom')
    }
  })

  test('refresh marks tmux timeouts with a structured error code', async () => {
    await loadWorker('refresh-timeout')

    bunAny.spawnSync = ((args: string[]) => {
      if (getTmuxSubcommand(args) === 'list-windows') {
        return {
          exitCode: null,
          signalCode: 'SIGTERM',
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as unknown as ReturnType<typeof Bun.spawnSync>
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    emitMessage({
      id: 'timeout-1',
      kind: 'refresh',
      managedSession: 'agentboard',
      discoverPrefixes: [],
    })

    const response = getLastResponse()
    expect(response.type).toBe('error')
    if (response.type === 'error') {
      expect(response.errorCode).toBe(TMUX_TIMEOUT_ERROR_CODE)
      expect(response.error).toContain('list-windows')
      expect(response.error).toContain('timed out')
    }
  })

  test('shutdown closes the worker without posting a response', async () => {
    await loadWorker('shutdown')

    emitMessage({
      id: 'shutdown-1',
      kind: 'shutdown',
    })

    expect(closeCalls).toBe(1)
    expect(messages).toHaveLength(0)
  })

  test('status changes track content updates and permission prompts', async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      await loadWorker('status-changes')

      const listOutput = [
        joinTmuxFields(['agentboard', '1', 'alpha', '/Users/test/project', '100', '1700000000', 'codex', '80', '24']),
      ].join('\n')

      const captureSequence = [
        'idle',
        'idle',
        'new output',
        'Do you want to proceed? [Y/n]',
      ]
      let captureIndex = 0

      bunAny.spawnSync = ((args: string[]) => {
        if (getTmuxSubcommand(args) === 'list-windows') {
          return {
            exitCode: 0,
            stdout: Buffer.from(listOutput),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        if (getTmuxSubcommand(args) === 'capture-pane') {
          const output = captureSequence[captureIndex] ?? ''
          captureIndex += 1
          return {
            exitCode: 0,
            stdout: Buffer.from(output),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync

      const runRefresh = () => {
        emitMessage({
          id: `refresh-${now}`,
          kind: 'refresh',
          managedSession: 'agentboard',
          discoverPrefixes: [],
        })
        const response = getLastResponse()
        if (response.type !== 'result' || response.kind !== 'refresh') {
          throw new Error('Unexpected response type')
        }
        return response.sessions[0] as Session
      }

      const first = runRefresh()
      const firstActivity = Date.parse(first.lastActivity)
      expect(first.status).toBe('waiting')

      // Advance past the grace period (4000ms) to trigger "waiting" on unchanged content
      now += 5000
      const second = runRefresh()
      const secondActivity = Date.parse(second.lastActivity)
      expect(second.status).toBe('waiting')
      expect(secondActivity).toBe(firstActivity)

      now += 1000
      const third = runRefresh()
      const thirdActivity = Date.parse(third.lastActivity)
      expect(third.status).toBe('working')
      expect(thirdActivity).toBe(now)

      now += 1000
      const fourth = runRefresh()
      const fourthActivity = Date.parse(fourth.lastActivity)
      expect(fourth.status).toBe('working')
      expect(fourthActivity).toBe(now)
    } finally {
      Date.now = originalNow
    }
  })

  test('status skips grace-period working on first observation', async () => {
    const originalNow = Date.now
    const originalGraceEnv = process.env.AGENTBOARD_WORKING_GRACE_MS
    process.env.AGENTBOARD_WORKING_GRACE_MS = '4000'
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      await loadWorker('status-first-observation')

      const listOutput = [
        joinTmuxFields(['agentboard', '1', 'alpha', '/Users/test/project', '100', '1700000000', 'codex', '80', '24']),
      ].join('\n')

      const captureSequence = ['idle', 'idle']
      let captureIndex = 0

      bunAny.spawnSync = ((args: string[]) => {
        if (getTmuxSubcommand(args) === 'list-windows') {
          return {
            exitCode: 0,
            stdout: Buffer.from(listOutput),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        if (getTmuxSubcommand(args) === 'capture-pane') {
          const output = captureSequence[captureIndex] ?? ''
          captureIndex += 1
          return {
            exitCode: 0,
            stdout: Buffer.from(output),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync

      const runRefresh = () => {
        emitMessage({
          id: `refresh-${now}`,
          kind: 'refresh',
          managedSession: 'agentboard',
          discoverPrefixes: [],
        })
        const response = getLastResponse()
        if (response.type !== 'result' || response.kind !== 'refresh') {
          throw new Error('Unexpected response type')
        }
        return response.sessions[0] as Session
      }

      const first = runRefresh()
      const firstActivity = Date.parse(first.lastActivity)
      expect(first.status).toBe('waiting')

      now += 1000
      const second = runRefresh()
      const secondActivity = Date.parse(second.lastActivity)
      expect(second.status).toBe('waiting')
      expect(secondActivity).toBe(firstActivity)
    } finally {
      Date.now = originalNow
      if (originalGraceEnv === undefined) {
        delete process.env.AGENTBOARD_WORKING_GRACE_MS
      } else {
        process.env.AGENTBOARD_WORKING_GRACE_MS = originalGraceEnv
      }
    }
  })

  test('refresh preserves lastActivity when pane capture times out', async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      await loadWorker('status-timeout-preserve')

      const listOutput = [
        joinTmuxFields(['agentboard', '1', 'alpha', '/Users/test/project', '100', '1700000000', 'codex', '80', '24']),
      ].join('\n')
      const captureSequence = ['idle', null] as const
      let captureIndex = 0

      bunAny.spawnSync = ((args: string[]) => {
        if (getTmuxSubcommand(args) === 'list-windows') {
          return {
            exitCode: 0,
            stdout: Buffer.from(listOutput),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        if (getTmuxSubcommand(args) === 'capture-pane') {
          const output = captureSequence[captureIndex++] ?? null
          if (output === null) {
            return {
              exitCode: null,
              signalCode: 'SIGTERM',
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
            } as unknown as ReturnType<typeof Bun.spawnSync>
          }
          return {
            exitCode: 0,
            stdout: Buffer.from(output),
            stderr: Buffer.from(''),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return {
          exitCode: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
        } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync

      const runRefresh = () => {
        emitMessage({
          id: `refresh-timeout-${now}`,
          kind: 'refresh',
          managedSession: 'agentboard',
          discoverPrefixes: [],
        })
        const response = getLastResponse()
        if (response.type !== 'result' || response.kind !== 'refresh') {
          throw new Error('Unexpected response type')
        }
        return response.sessions[0] as Session
      }

      const first = runRefresh()
      const firstActivity = first.lastActivity
      expect(first.status).toBe('waiting')

      now += 5000
      const second = runRefresh()
      expect(second.status).toBe('waiting')
      expect(second.lastActivity).toBe(firstActivity)
    } finally {
      Date.now = originalNow
    }
  })
})
