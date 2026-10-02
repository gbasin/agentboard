// ensureSessionAsync is the refresh-tick entry point. Its steady state (base
// session present, identity unchanged) must run the probe through the async
// runner only, so a slow tmux server never blocks the event loop on every
// tick. Every other outcome must end up exactly where sync ensureSession does.
import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { TMUX_FIELD_SEPARATOR } from '../tmuxFormat'
import { TmuxTimeoutError } from '../tmuxTimeout'

const SESSION = 'agentboard-ensure-async'
const PROBE = 'display-message'
const CONFIGURE = ['set-option', 'set-environment']

function commandOf(args: string[]): string {
  return (args[0] === '-u' ? args[1] : args[0]) ?? ''
}

function probeRow(name: string, pid: number, id: string, created: string): string {
  return [name, String(pid), id, created].join(TMUX_FIELD_SEPARATOR) + '\n'
}

function createHarness() {
  const syncCalls: string[] = []
  const asyncCalls: string[] = []
  const rememberedPids: number[] = []
  const state = {
    sessionExists: true,
    serverPid: 4242,
    sessionId: 0,
    sessionCreated: 1790000000,
    asyncTimeout: false,
  }

  const answer = (args: string[]): string => {
    switch (commandOf(args)) {
      case PROBE:
        return state.sessionExists
          ? probeRow(SESSION, state.serverPid, `$${state.sessionId}`, String(state.sessionCreated))
          : probeRow('', state.serverPid, '', '')
      case 'new-session':
        state.sessionExists = true
        state.sessionId += 1
        state.sessionCreated += 1
        return ''
      case 'list-sessions':
      case 'set-option':
      case 'set-environment':
        return ''
      default:
        throw new Error(`Unhandled tmux command: ${args.join(' ')}`)
    }
  }

  const manager = new SessionManager(SESSION, {
    runTmux: (args) => {
      syncCalls.push(commandOf(args))
      return answer(args)
    },
    runTmuxAsync: async (args) => {
      asyncCalls.push(commandOf(args))
      if (state.asyncTimeout) throw new TmuxTimeoutError(commandOf(args), 3000)
      return answer(args)
    },
    capturePaneContent: () => null,
    rememberTmuxServerPid: (pid) => {
      rememberedPids.push(pid)
    },
  })

  const take = () => ({
    sync: syncCalls.splice(0, syncCalls.length),
    async: asyncCalls.splice(0, asyncCalls.length),
  })
  return { manager, state, rememberedPids, take }
}

describe('SessionManager.ensureSessionAsync', () => {
  test('steady state runs one async probe and no sync tmux call', async () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.take()

    expect(await h.manager.ensureSessionAsync()).toEqual({ canPruneWsSessions: true })
    await h.manager.ensureSessionAsync()
    expect(h.take()).toEqual({ sync: [], async: [PROBE, PROBE] })
    expect(h.rememberedPids).toEqual([4242, 4242, 4242])
  })

  test('an unconfigured manager configures from the async probe result', async () => {
    const h = createHarness()
    await h.manager.ensureSessionAsync()
    // Same spawns as sync ensureSession's first call, minus the blocking probe.
    expect(h.take()).toEqual({ sync: CONFIGURE, async: [PROBE] })
    expect(h.rememberedPids).toEqual([4242])
  })

  test('a changed identity reconfigures without a second probe', async () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.take()

    h.state.serverPid = 5151
    await h.manager.ensureSessionAsync()
    expect(h.take()).toEqual({ sync: CONFIGURE, async: [PROBE] })
    expect(h.rememberedPids).toEqual([4242, 5151])
  })

  test('a missing session falls back to the sync create path', async () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.take()

    h.state.sessionExists = false
    await h.manager.ensureSessionAsync()
    expect(h.take()).toEqual({
      sync: [PROBE, 'list-sessions', 'new-session', ...CONFIGURE, PROBE],
      async: [PROBE],
    })

    await h.manager.ensureSessionAsync()
    expect(h.take()).toEqual({ sync: [], async: [PROBE] })
  })

  test('a probe timeout rejects without a blocking retry', async () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.take()

    h.state.asyncTimeout = true
    await expect(h.manager.ensureSessionAsync()).rejects.toBeInstanceOf(TmuxTimeoutError)
    expect(h.take()).toEqual({ sync: [], async: [PROBE] })
  })

  test('without an async override it reuses the sync runner override', async () => {
    const calls: string[] = []
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => {
        calls.push(commandOf(args))
        return commandOf(args) === PROBE ? probeRow(SESSION, 4242, '$0', '1790000000') : ''
      },
      capturePaneContent: () => null,
      rememberTmuxServerPid: () => {},
    })
    await manager.ensureSessionAsync()
    expect(calls).toEqual([PROBE, ...CONFIGURE])
  })
})
