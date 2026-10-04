import { describe, expect, test } from 'bun:test'
import {
  GroupKillRefusedError,
  prepareGroupedLastWindowKill,
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

describe('prepareGroupedLastWindowKill', () => {
  const mirror = `${WS}${CONN}-x-cgl-3od92g`
  const home = `${WS}${CONN}`

  test('switches proxy clients home, detaches others, kills members, leaves target clients', () => {
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

    const result = prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`],
      ['detach-client', '-t', '/dev/ttys002'],
      ['kill-session', '-t', `=${mirror}`],
      ['kill-session', '-t', '=cgl-pair'],
    ])
    expect(result.killedSessions).toEqual([mirror, 'cgl-pair'])
    expect(result.detachedClients).toEqual(['/dev/ttys002'])
    // The target's own client is left to tmux's detach-on-destroy.
    expect(state.clients.get('/dev/ttys003')).toBe('cgl')
  })

  test('detaches a mirror client whose proxy session is gone', () => {
    const { runTmux, calls } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [['/dev/ttys001', mirror]]
    )

    prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)

    expect(calls).toContainEqual(['detach-client', '-t', '/dev/ttys001'])
    expect(calls.some((call) => call[0] === 'switch-client')).toBe(false)
  })

  test('issues no mutations when the target is alone in its group', () => {
    const { runTmux, calls } = fakeTmux([['cgl', 'cgl']], [['/dev/ttys003', 'cgl']])

    const result = prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)

    expect(calls.map((call) => call[0])).toEqual(['list-sessions'])
    expect(result.killedSessions).toEqual([])
    expect(result.failed).toEqual([])
  })

  test('refuses when a member cannot be killed', () => {
    const { runTmux: base } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      []
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'kill-session' && args[2] === `=${mirror}`) {
        throw new Error('server refused')
      }
      return base(args)
    }

    let caught: unknown
    try {
      prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GroupKillRefusedError)
    expect((caught as Error).message).toBe(
      `refusing to kill last window of grouped session cgl: could not kill ${mirror}`
    )
    expect((caught as GroupKillRefusedError).evacuation.killedSessions).toEqual(['cgl-pair'])
  })

  test('stops mutating at the first timeout and refuses', () => {
    const { runTmux: base, calls } = fakeTmux(
      [
        [home, 'agentboard'],
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
        ['cgl-pair', 'cgl'],
      ],
      [['/dev/ttys001', mirror]]
    )
    const runTmux = (args: string[]): string => {
      if (args[0] === 'switch-client') {
        calls.push(args)
        throw new TmuxTimeoutError('switch-client', 15000)
      }
      return base(args)
    }

    expect(() => prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)).toThrow(
      'refusing to kill last window of grouped session cgl: a tmux command timed out'
    )
    // Nothing after the timed-out switch: no detach fallback, no kills.
    expect(mutations(calls)).toEqual([
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`],
    ])
  })

  test('refuses when a member appears after the last pass', () => {
    let listings = 0
    const { runTmux } = fakeTmux(
      [
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [],
      (argv, live) => {
        // A proxy keeps re-creating its mirror (new-session -t) right after
        // every snapshot.
        if (argv[0] === 'list-sessions') {
          listings++
          if (listings > 1) live.sessions.set(`${mirror}-${listings}`, 'cgl')
        }
      }
    )

    expect(() => prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)).toThrow(
      /refusing to kill last window of grouped session cgl: other members still alive: /
    )
  })

  test('second pass catches a mirror and switch that landed mid-evacuation', () => {
    const lateMirror = `${WS}${CONN}-x-cgl-late01`
    let injected = false
    const { runTmux, calls, state } = fakeTmux(
      [
        [home, 'agentboard'],
        ['cgl', 'cgl'],
        [mirror, 'cgl'],
      ],
      [['/dev/ttys001', home]],
      (argv, live) => {
        // The proxy's new-session -t and async switch-client complete right
        // after the first client snapshot.
        if (argv[0] === 'list-clients' && !injected) {
          injected = true
          live.sessions.set(lateMirror, 'cgl')
          live.clients.set('/dev/ttys001', lateMirror)
        }
      }
    )

    const result = prepareGroupedLastWindowKill(runTmux, 'cgl', 'cgl', WS)

    expect(mutations(calls)).toEqual([
      ['kill-session', '-t', `=${mirror}`],
      ['switch-client', '-c', '/dev/ttys001', '-t', `=${home}`],
      ['kill-session', '-t', `=${lateMirror}`],
    ])
    expect(result.killedSessions).toEqual([mirror, lateMirror])
    expect(state.clients.get('/dev/ttys001')).toBe(home)
  })
})
