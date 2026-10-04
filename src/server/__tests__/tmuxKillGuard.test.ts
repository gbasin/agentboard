import { describe, expect, test } from 'bun:test'
import { evacuateSessionGroup, proxySessionForMirror } from '../tmuxKillGuard'
import { buildTmuxFormat } from '../tmuxFormat'

const WS = 'agentboard-ws-'
const CONN = '0b7c2d1e-aaaa-4bbb-8ccc-123456789abc'

function fakeTmux(sessions: Array<[string, string]>, clients: Array<[string, string]>) {
  const calls: string[][] = []
  const runTmux = (args: string[]): string => {
    const argv = args[0] === '-u' ? args.slice(1) : args
    calls.push(argv)
    if (argv[0] === 'list-sessions') return sessions.map((row) => buildTmuxFormat(row)).join('\n')
    if (argv[0] === 'list-clients') return clients.map((row) => buildTmuxFormat(row)).join('\n')
    return ''
  }
  return { runTmux, calls }
}

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

    expect(calls.slice(2)).toEqual([
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

    expect(calls.slice(2)).toEqual([['detach-client', '-t', '/dev/ttys003']])
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
      const out = base(args)
      if (args[0] === 'detach-client') throw new Error("can't find client: /dev/ttys009")
      if (args[0] === 'kill-session' && args[2] === `=${mirror}`) {
        throw new Error('tmux kill-session timed out after 15000ms')
      }
      return out
    }

    const result = evacuateSessionGroup(runTmux, 'cgl', 'cgl', WS)

    expect(calls.filter((call) => call[0] === 'kill-session')).toHaveLength(2)
    expect(result.failed).toEqual([
      { command: 'kill-session', target: mirror, error: 'tmux kill-session timed out after 15000ms' },
    ])
    expect(result.killedSessions).toEqual(['cgl-pair'])
    expect(result.detachedClients).toEqual([])
  })
})
