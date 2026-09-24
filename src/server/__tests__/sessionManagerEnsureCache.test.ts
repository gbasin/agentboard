// Covers ensureSession's steady-state contract: once the base session is
// configured on a live tmux server, refresh ticks run only has-session and
// skip the set-option/set-environment/display-message spawns.
import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'

const SESSION = 'agentboard-ensure-cache'

function commandOf(args: string[]): string {
  return (args[0] === '-u' ? args[1] : args[0]) ?? ''
}

function createHarness(options: { serverPid?: number } = {}) {
  const calls: string[] = []
  const rememberedPids: number[] = []
  const alivePids = new Set<number>()
  const state = {
    sessionExists: true,
    serverPid: options.serverPid ?? 4242,
  }
  alivePids.add(state.serverPid)

  const runTmux = (args: string[]): string => {
    const command = commandOf(args)
    calls.push(command)
    switch (command) {
      case 'has-session':
        if (!state.sessionExists) throw new Error(`can't find session: ${SESSION}`)
        return ''
      case 'list-sessions':
        return ''
      case 'new-session':
        state.sessionExists = true
        return ''
      case 'display-message':
        return `${state.serverPid}\n`
      case 'set-option':
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
    rememberTmuxServerPid: (pid) => rememberedPids.push(pid),
    isProcessAlive: (pid) => alivePids.has(pid),
  })

  const takeCalls = () => calls.splice(0, calls.length)
  return { manager, state, alivePids, rememberedPids, takeCalls }
}

const CONFIGURE_AND_RECORD = ['set-option', 'set-environment', 'display-message']

describe('SessionManager.ensureSession server-pid cache', () => {
  test('first call configures the session and records the server pid', () => {
    const h = createHarness()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual(['has-session', ...CONFIGURE_AND_RECORD])
    expect(h.rememberedPids).toEqual([4242])
  })

  test('later calls with a live server pid run only has-session', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.manager.ensureSession()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual(['has-session', 'has-session'])
    // The pid file is re-asserted each tick without a tmux spawn.
    expect(h.rememberedPids).toEqual([4242, 4242, 4242])
  })

  test('steady-state calls restore a pid file overwritten by another instance', () => {
    const store: { pid: number | null } = { pid: null }
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => (commandOf(args) === 'display-message' ? '4242\n' : ''),
      capturePaneContent: () => null,
      rememberTmuxServerPid: (pid) => {
        store.pid = pid
      },
      isProcessAlive: () => true,
    })

    manager.ensureSession()
    expect(store.pid).toBe(4242)
    store.pid = 9999 // a dev instance on another tmux socket wrote its pid
    manager.ensureSession()
    expect(store.pid).toBe(4242)
  })

  test('a failed steady-state pid-file write does not fail ensureSession', () => {
    let failWrite = false
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => (commandOf(args) === 'display-message' ? '4242\n' : ''),
      capturePaneContent: () => null,
      rememberTmuxServerPid: () => {
        if (failWrite) throw new Error('EACCES')
      },
      isProcessAlive: () => true,
    })

    manager.ensureSession()
    failWrite = true
    expect(manager.ensureSession()).toEqual({ canPruneWsSessions: true })
  })

  test('a dead cached pid triggers reconfigure and re-record', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    // tmux server restarted externally with the same session name.
    h.alivePids.delete(4242)
    h.state.serverPid = 5151
    h.alivePids.add(5151)

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual(['has-session', ...CONFIGURE_AND_RECORD])
    expect(h.rememberedPids).toEqual([4242, 5151])

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual(['has-session'])
  })

  test('recreating a missing session reconfigures even when the pid is alive', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.state.sessionExists = false
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([
      'has-session',
      'list-sessions',
      'new-session',
      ...CONFIGURE_AND_RECORD,
    ])

    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual(['has-session'])
  })

  test('socket recovery reconfigures even when the cached pid is alive', () => {
    const calls: string[] = []
    let socketReachable = true
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => {
        const command = commandOf(args)
        calls.push(command)
        if (command === 'has-session' && !socketReachable) {
          throw new Error('no server running on /tmp/tmux-501/default')
        }
        return command === 'display-message' ? '4242\n' : ''
      },
      capturePaneContent: () => null,
      recoverTmuxSocket: () => {
        socketReachable = true
        return true
      },
      rememberTmuxServerPid: () => {},
      isProcessAlive: () => true,
    })

    manager.ensureSession()
    calls.length = 0
    socketReachable = false
    manager.ensureSession()
    expect(calls).toEqual(['has-session', 'has-session', ...CONFIGURE_AND_RECORD])
  })

  test('an unreadable server pid retries configuration on the next call', () => {
    const h = createHarness()
    h.state.serverPid = Number.NaN
    h.manager.ensureSession()
    h.manager.ensureSession()
    expect(h.takeCalls()).toEqual([
      'has-session', ...CONFIGURE_AND_RECORD,
      'has-session', ...CONFIGURE_AND_RECORD,
    ])
    expect(h.rememberedPids).toEqual([])
  })

  test('a failed pid-file write retries on the next call', () => {
    const calls: string[] = []
    let failWrite = true
    const remembered: number[] = []
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => {
        calls.push(commandOf(args))
        return commandOf(args) === 'display-message' ? '4242\n' : ''
      },
      capturePaneContent: () => null,
      rememberTmuxServerPid: (pid) => {
        if (failWrite) throw new Error('EACCES')
        remembered.push(pid)
      },
      isProcessAlive: () => true,
    })

    manager.ensureSession()
    failWrite = false
    manager.ensureSession()
    manager.ensureSession()
    expect(calls).toEqual([
      'has-session', ...CONFIGURE_AND_RECORD,
      'has-session', ...CONFIGURE_AND_RECORD,
      'has-session',
    ])
    expect(remembered).toEqual([4242, 4242])
  })

  test('a failed configure retries on the next call', () => {
    const h = createHarness()
    let failSetOption = true
    const manager = new SessionManager(SESSION, {
      runTmux: (args) => {
        if (commandOf(args) === 'set-option' && failSetOption) {
          throw new Error('set-option failed')
        }
        return commandOf(args) === 'display-message' ? '4242\n' : ''
      },
      capturePaneContent: () => null,
      rememberTmuxServerPid: (pid) => h.rememberedPids.push(pid),
      isProcessAlive: () => true,
    })

    expect(() => manager.ensureSession()).toThrow('set-option failed')
    expect(h.rememberedPids).toEqual([])
    failSetOption = false
    manager.ensureSession()
    expect(h.rememberedPids).toEqual([4242])
  })

  test('listWindows shares the cache and skips reconfigure on a live server', () => {
    const h = createHarness()
    h.manager.ensureSession()
    h.takeCalls()

    h.manager.listWindows()
    const calls = h.takeCalls()
    expect(calls.filter((c) => CONFIGURE_AND_RECORD.includes(c))).toEqual([])

    h.alivePids.delete(4242)
    h.manager.listWindows()
    expect(h.takeCalls().filter((c) => CONFIGURE_AND_RECORD.includes(c))).toEqual(
      CONFIGURE_AND_RECORD
    )
  })
})
