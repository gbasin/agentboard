import { describe, expect, test } from 'bun:test'
import { evacuateSessionGroup, proxySessionForMirror } from '../tmuxKillGuard'
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
        state.sessions.delete(target)
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

describe('evacuateSessionGroup', () => {
  test('switches proxy clients home, detaches others and target clients, then kills members', () => {
    const mirror = `${WS}${CONN}-x-cgl-3od92g`
    const { runTmux, calls } = fakeTmux(
      [
        ['agentboard', 'agentboard'],
        [`${WS}${CONN}`, 'agentboard'],
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

    const result = evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${WS}${CONN}`],
      ['detach-client', '-t', '/dev/ttys002'],
      ['detach-client', '-t', '/dev/ttys003'],
      ['kill-session', '-t', `=${mirror}`],
      ['kill-session', '-t', '=cgl-pair'],
    ])
    expect(result.killedSessions).toEqual([mirror, 'cgl-pair'])
    expect(result.detachedClients).toEqual(['/dev/ttys002', '/dev/ttys003'])
  })

  test('detaches a mirror client whose proxy session is gone', () => {
    const mirror = `${WS}${CONN}-x-cgl-3od92g`
    const { runTmux, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [['/dev/ttys001', mirror]]
    )

    evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    expect(calls).toContainEqual(['detach-client', '-t', '/dev/ttys001'])
    expect(calls.some((call) => call[0] === 'switch-client')).toBe(false)
  })

  test('detaches clients on the target even when it is alone in its group', () => {
    const { runTmux, calls } = fakeTmux([['cgl', 'cgl']], [['/dev/ttys003', 'cgl']])

    const result = evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([['detach-client', '-t', '/dev/ttys003']])
    expect(result.detachedClients).toEqual(['/dev/ttys003'])
    expect(result.killedSessions).toEqual([])
    expect(result.failed).toEqual([])
  })

  test('reports failed mutations but treats already-gone targets as done', () => {
    const mirror = `${WS}${CONN}-x-cgl-3od92g`
    const { runTmux: base, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      [['/dev/ttys009', 'cgl']]
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'detach-client') {
        base(args)
        throw new Error("can't find client: /dev/ttys009")
      }
      if (args[0] === 'kill-session' && args[2] === `=${mirror}`) {
        calls.push(args)
        throw new Error('tmux kill-session timed out after 15000ms')
      }
      return base(args)
    }

    const result = evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    const timeout = {
      command: 'kill-session',
      target: mirror,
      error: 'tmux kill-session timed out after 15000ms',
    }
    // The second pass retries the stuck member and reports it again.
    expect(result.failed).toEqual([timeout, timeout])
    expect(result.killedSessions).toEqual(['cgl-pair'])
    expect(result.detachedClients).toEqual([])
  })

  test('second pass catches a mirror and switch that landed mid-evacuation', () => {
    const home = `${WS}${CONN}`
    const lateMirror = `${WS}${CONN}-x-cgl-3od92g`
    let injected = false
    const { runTmux, calls, state } = fakeTmux(
      [
        [home, 'agentboard'],
        ['cgl', 'cgl'],
      ],
      [['/dev/ttys001', home]],
      (argv, live) => {
        // The proxy's new-session -t and async switch-client complete right
        // after the first snapshot.
        if (argv[0] === 'list-clients' && !injected) {
          injected = true
          live.sessions.set(lateMirror, 'cgl')
          live.clients.set('/dev/ttys001', lateMirror)
        }
      }
    )

    const result = evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`],
      ['kill-session', '-t', `=${lateMirror}`],
    ])
    expect(result.killedSessions).toEqual([lateMirror])
    expect(state.clients.get('/dev/ttys001')).toBe(home)
    expect(state.sessions.has(lateMirror)).toBe(false)
  })
})
