// Covers ensureSession's steady-state contract: one display-message probe
// returns the base session's identity (server pid + session_created). While
// the identity matches what this manager configured, refresh ticks skip the
// set-option/set-environment spawns.
import { describe, expect, test } from 'bun:test'
import os from 'node:os'
import { SessionManager } from '../SessionManager'
import { TMUX_FIELD_SEPARATOR } from '../tmuxFormat'

const SESSION = 'agentboard-ensure-cache'
const PROBE = 'display-message'
const CONFIGURE = ['set-option', 'set-environment']

function commandOf(args: string[]): string {
  return (args[0] === '-u' ? args[1] : args[0]) ?? ''
}

function probeRow(name: string, pid: number, id: string, created: string): string {
  return [name, String(pid), id, created].join(TMUX_FIELD_SEPARATOR) + '\n'
}

function createHarness() {
  const calls: string[] = []
  const rememberedPids: number[] = []
  const state = {
    serverUp: true,
    sessionExists: true,
    serverPid: 4242,
    sessionId: 0,
    sessionCreated: 1790000000,
    failSetOption: false,
    failRemember: false,
  }

  const runTmux = (args: string[]): string => {
    const command = commandOf(args)
    calls.push(command)
    if (!state.serverUp) {
      throw new Error('no server running on /tmp/tmux-501/default')
    }
    switch (command) {
      case PROBE:
        // Real tmux (CMD_FIND_CANFAIL): a missing session exits 0 with
        // empty session fields.
        return state.sessionExists
          ? probeRow(SESSION, state.serverPid, `$${state.sessionId}`, String(state.sessionCreated))
          : probeRow('', state.serverPid, '', '')
      case 'new-session':
        state.sessionExists = true
        state.sessionId += 1
        state.sessionCreated += 1
        return ''
      case 'set-option':
        if (state.failSetOption) throw new Error('set-option timed out')
        return ''
      case 'has-session':
        if (!state.sessionExists) throw new Error(`can't find session: ${SESSION}`)
        return ''
      case 'list-sessions':
      case 'set-environment':
      case 'list-windows':
        return ''
      default:
        throw new Error(`Unhandled tmux command: ${args.join(' ')}`)
    }
  }

  const manager = new SessionManager(SESSION, {
    runTmux,
    capturePaneContent: () => null,
    rememberTmuxServerPid: (pid) => {
      if (state.failRemember) throw new Error('EACCES')
      rememberedPids.push(pid)
    },
  })

  const takeCalls = () => calls.splice(0, calls.length)
  return { manager, state, rememberedPids, takeCalls }
}

describe('SessionManager.ensureSession identity cache', () => {
  test('first call configures the session and records the server pid', () => {
    const h = createHarness()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, ...CONFIGURE])
    expect(h.rememberedPids).toEqual([4242])
  })

  test('later calls with an unchanged identity run exactly one probe', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.manager.ensureSession()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, PROBE])
    // The pid file is re-asserted each tick without a tmux spawn.
    expect(h.rememberedPids).toEqual([4242, 4242, 4242])
  })

  test('same server pid with a new session_created reconfigures', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    // Base session killed and recreated externally on the same live server.
    h.state.sessionCreated += 5
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, ...CONFIGURE])

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE])
  })

  test('a new session_id within the same second reconfigures', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.state.sessionId += 1
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, ...CONFIGURE])
  })

  test('a changed server pid reconfigures and re-records', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.state.serverPid = 5151
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, ...CONFIGURE])
    expect(h.rememberedPids).toEqual([4242, 5151])

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE])
  })

  test('a missing session is created, configured and recorded', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.state.sessionExists = false
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([
      PROBE,
      'list-sessions',
      'new-session',
      ...CONFIGURE,
      PROBE,
    ])

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE])
  })

  test('socket recovery reconfigures even when the identity is unchanged', () => {
    const calls: string[] = []
    let socketReachable = true
    let recovered = 0
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => {
        const command = commandOf(args)
        calls.push(command)
        if (command === PROBE && !socketReachable) {
          throw new Error('no server running on /tmp/tmux-501/default')
        }
        return command === PROBE ? probeRow(SESSION, 4242, '$0', '1790000000') : ''
      },
      capturePaneContent: () => null,
      recoverTmuxSocket: () => {
        recovered += 1
        socketReachable = true
        return true
      },
      rememberTmuxServerPid: () => {},
    })

    manager.ensureSession()
    calls.length = 0
    socketReachable = false
    manager.ensureSession()
    expect(recovered).toBe(1)
    expect(calls).toEqual([PROBE, PROBE, ...CONFIGURE])
  })

  test('steady-state calls restore a pid file overwritten by another instance', () => {
    const store: { pid: number | null } = { pid: null }
    const manager = new SessionManager(SESSION, {
      runTmux: (args) =>
        commandOf(args) === PROBE ? probeRow(SESSION, 4242, '$0', '1790000000') : '',
      capturePaneContent: () => null,
      rememberTmuxServerPid: (pid) => {
        store.pid = pid
      },
    })

    manager.ensureSession()
    expect(store.pid).toBe(4242)
    store.pid = 9999 // a dev instance on another tmux socket wrote its pid
    manager.ensureSession()
    expect(store.pid).toBe(4242)
  })

  test('a failed steady-state pid-file write does not fail ensureSession', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.state.failRemember = true
    expect(h.manager.ensureSession()).toEqual({ canPruneWsSessions: true })
  })

  test('a failed pid-file write on configure retries on the next call', () => {
    const h = createHarness()
    h.state.failRemember = true
    h.manager.ensureSession()
    h.state.failRemember = false
    h.manager.ensureSession()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([
      PROBE, ...CONFIGURE,
      PROBE, ...CONFIGURE,
      PROBE,
    ])
    expect(h.rememberedPids).toEqual([4242, 4242])
  })

  test('a failed configure retries on the next call', () => {
    const h = createHarness()
    h.state.failSetOption = true
    expect(() => h.manager.ensureSession()).toThrow('set-option timed out')
    expect(h.rememberedPids).toEqual([])
    h.state.failSetOption = false
    h.manager.ensureSession()
    expect(h.rememberedPids).toEqual([4242])
  })

  test('a failed configure after createWindow recreates the session retries next tick', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.state.sessionExists = false
    h.state.failSetOption = true
    expect(() => h.manager.createWindow(os.tmpdir(), 'alpha', 'claude')).toThrow(
      'set-option timed out'
    )
    h.state.failSetOption = false
    h.takeCalls()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE, ...CONFIGURE])
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([PROBE])
  })

  test('a missing server is not treated as an existing session', () => {
    const h = createHarness()
    h.state.serverUp = false
    expect(() => h.manager.ensureSession()).toThrow()
    expect(h.takeCalls()).toContain(PROBE)
    expect(h.rememberedPids).toEqual([])
  })

  test('listWindows probes once and shares the cache', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.manager.listWindows()
    const calls = h.takeCalls()
    expect(calls.filter((c) => c === PROBE)).toEqual([PROBE])
    expect(calls.filter((c) => CONFIGURE.includes(c))).toEqual([])

    h.state.sessionCreated += 1
    h.manager.listWindows()
    expect(h.takeCalls().filter((c) => CONFIGURE.includes(c))).toEqual(CONFIGURE)
  })
})
