import { describe, expect, test } from 'bun:test'
import {
  GroupKillRefusedError,
  killGroupedSessionLastWindow,
  proxySessionForMirror,
} from '../tmuxKillGuard'
import { TmuxTimeoutError } from '../tmuxTimeout'
import { buildTmuxFormat } from '../tmuxFormat'

const WS = 'agentboard-ws-'
const CONN = '0b7c2d1e-aaaa-4bbb-8ccc-123456789abc'

// Minimal stateful tmux model: sessions (name -> group) and clients
// (tty -> session). `beforeCall` can mutate the state to simulate a proxy
// acting concurrently.
function fakeTmux(
  sessionRows: Array<[string, string]>,
  clientRows: Array<[string, string]>,
  beforeCall?: (
    argv: string[],
    state: { sessions: Map<string, string>; clients: Map<string, string> }
  ) => void
) {
  const state = { sessions: new Map(sessionRows), clients: new Map(clientRows) }
  const calls: string[][] = []
  const runTmux = (args: string[]): string => {
    const argv = args[0] === '-u' ? args.slice(1) : args
    calls.push(argv)
    beforeCall?.(argv, state)
    const target = (argv[argv.indexOf('-t') + 1] ?? '').replace(/^=/, '')
    switch (argv[0]) {
      case 'list-sessions':
        return [...state.sessions].map((row) => buildTmuxFormat(row)).join('\n')
      case 'list-clients':
        return [...state.clients].map((row) => buildTmuxFormat(row)).join('\n')
      case 'switch-client':
        state.clients.set(argv[argv.indexOf('-c') + 1] ?? '', target)
        return ''
      case 'detach-client':
        state.clients.delete(target)
        return ''
      case 'kill-session':
        if (!state.sessions.delete(target)) throw new Error(`can't find session: ${target}`)
        for (const [tty, session] of state.clients) {
          if (session === target) state.clients.delete(tty)
        }
        return ''
      default:
        return ''
    }
  }
  return { runTmux, calls, state }
}

const mutations = (calls: string[][]) =>
  calls.filter((call) => !call[0]?.startsWith('list-'))

describe('proxySessionForMirror', () => {
  test('maps an external mirror to its proxy session', () => {
    expect(proxySessionForMirror(`${WS}${CONN}-x-cgl-3od92g`, WS)).toBe(`${WS}${CONN}`)
    // A raw name containing -x- still splits at the first marker.
    expect(proxySessionForMirror(`${WS}${CONN}-x-a-x-b-123abc`, WS)).toBe(`${WS}${CONN}`)
  })

  test('ignores non-mirror sessions', () => {
    expect(proxySessionForMirror(`${WS}${CONN}`, WS)).toBeNull()
    expect(proxySessionForMirror('cgl-pair', WS)).toBeNull()
  })
})

describe('killGroupedSessionLastWindow', () => {
  const mirror = `${WS}${CONN}-x-cgl-3od92g`
  const home = `${WS}${CONN}`
  const killTarget = ['kill-session', '-t', '=cgl']
  const sweep = ['list-sessions', '-F', expect.any(String)]

  test('moves member clients, kills members, then the target, then sweeps', () => {
    const { runTmux, calls, state } = fakeTmux(
      [
        ['agentboard', 'agentboard'],
        [home, 'agentboard'],
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      [
        ['/dev/ttys001', mirror],
        ['/dev/ttys002', 'cgl-pair'],
        ['/dev/ttys003', 'cgl'],
      ]
    )

    const result = killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(calls).toEqual([
      ['list-sessions', '-F', expect.any(String)],
      ['list-clients', '-F', expect.any(String)],
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`],
      ['detach-client', '-t', '/dev/ttys002'],
      ['kill-session', '-t', `=${mirror}`],
      ['kill-session', '-t', '=cgl-pair'],
      killTarget,
      sweep,
    ])
    expect(result.killedSessions).toEqual([mirror, 'cgl-pair'])
    expect(result.sweptSessions).toEqual([])
    expect(result.switchedClients).toEqual([{ client: '/dev/ttys001', session: home }])
    expect(result.detachedClients).toEqual(['/dev/ttys002'])
    expect(state.clients.get('/dev/ttys001')).toBe(home)
    expect([...state.sessions.keys()]).toEqual(['agentboard', home])
  })

  test('detaches a mirror client whose proxy session is gone', () => {
    const { runTmux, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [['/dev/ttys001', mirror]]
    )

    killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['detach-client', '-t', '/dev/ttys001'],
      ['kill-session', '-t', `=${mirror}`],
      killTarget,
    ])
  })

  test('alone in its group: no client listing, just the target kill and sweep', () => {
    const { runTmux, calls } = fakeTmux([['cgl', 'cgl']], [['/dev/ttys003', 'cgl']])

    killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(calls).toEqual([['list-sessions', '-F', expect.any(String)], killTarget, sweep])
  })

  test('a client that vanished mid-move is not a failure', () => {
    const { runTmux: base, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      [['/dev/ttys002', 'cgl-pair']]
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'detach-client') {
        calls.push(args)
        throw new Error("can't find client: /dev/ttys002")
      }
      return base(args)
    }

    const result = killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(result.failed).toEqual([])
    expect(calls.slice(-3)).toEqual([['kill-session', '-t', '=cgl-pair'], killTarget, sweep])
  })

  test('refuses before any kill when a client move times out', () => {
    const { runTmux: base, calls } = fakeTmux(
      [
        [home, 'agentboard'],
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      [
        ['/dev/ttys001', mirror],
        ['/dev/ttys002', 'cgl-pair'],
      ]
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'switch-client') {
        calls.push(args)
        throw new TmuxTimeoutError('switch-client', 15000)
      }
      return base(args)
    }

    let caught: unknown
    try {
      killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GroupKillRefusedError)
    expect((caught as Error).message).toBe(
      'refusing to kill last window of grouped session cgl: a tmux command timed out'
    )
    // Nothing after the timed-out switch: no detach fallback, no kill.
    expect(mutations(calls)).toEqual([['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`]])
  })

  test('refuses when list-sessions has a malformed row', () => {
    const calls: string[][] = []
    const runTmux = (args: string[]): string => {
      calls.push(args)
      return `${buildTmuxFormat(['cgl', 'cgl'])}\ngarbage-without-separator\n`
    }

    expect(() => killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)).toThrow(
      /refusing to kill last window of grouped session cgl: unparseable tmux list-sessions row/
    )
    expect(calls.some((call) => call.includes('kill-session'))).toBe(false)
  })

  test('refuses when tmux cannot be listed', () => {
    const runTmux = (args: string[]): string => {
      if (args.includes('list-sessions')) throw new Error('lost server')
      return ''
    }

    expect(() => killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)).toThrow(
      'refusing to kill last window of grouped session cgl: tmux list-sessions failed: lost server'
    )
  })
  test('sweep kills a member that appeared after the listing', () => {
    let injected = false
    const { runTmux, calls, state } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [],
      (argv, live) => {
        // A proxy's new-session -t lands between the member kill and the
        // target kill.
        if (argv[0] === 'kill-session' && argv[2] === `=${mirror}` && !injected) {
          injected = true
          live.sessions.set(`${mirror}-late`, 'cgl')
        }
      }
    )

    const result = killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['kill-session', '-t', `=${mirror}`],
      killTarget,
      ['kill-session', '-t', `=${mirror}-late`],
    ])
    expect(result.sweptSessions).toEqual([`${mirror}-late`])
    expect(state.sessions.size).toBe(0)
  })

  test('a member that is already gone is not a failure; the target is still killed', () => {
    const { runTmux: base, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      []
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'kill-session' && args[2] === `=${mirror}`) {
        calls.push(args)
        throw new Error(`can't find session: ${mirror}`)
      }
      return base(args)
    }

    const result = killGroupedSessionLastWindow(runTmux, 'cgl', 'cgl', WS)

    expect(result.failed).toEqual([])
    expect(result.killedSessions).toEqual([])
    expect(calls).toContainEqual(killTarget)
  })
})
