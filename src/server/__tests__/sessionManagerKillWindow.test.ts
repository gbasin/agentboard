import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { logger } from '../logger'
import { SessionManager } from '../SessionManager'
import { buildTmuxFormat } from '../tmuxFormat'
import { TmuxTimeoutError } from '../tmuxTimeout'

// display-message output for KILL_TARGET_FORMAT: window_id, window_index,
// window_name, pane_current_path, session_name, session_windows,
// session_group. tmux prints a trailing newline.
const probe = (fields: string[]) => `${buildTmuxFormat(fields)}\n`

function recordingRunner(
  display: string | (() => string),
  extra: (argv: string[]) => string | undefined = () => undefined
) {
  const calls: string[][] = []
  const runTmux = (args: string[]): string => {
    const argv = args[0] === '-u' ? args.slice(1) : args
    calls.push(argv)
    if (argv[0] === 'display-message') return typeof display === 'string' ? display : display()
    return extra(argv) ?? ''
  }
  return { runTmux, calls }
}

const logged = (spy: ReturnType<typeof spyOn>, event: string) =>
  spy.mock.calls.find((call: unknown[]) => call[0] === event)?.[1] as
    | Record<string, unknown>
    | undefined

describe('SessionManager.killWindow', () => {
  const spies: Array<ReturnType<typeof spyOn>> = []
  const spy = (method: 'info' | 'warn') => {
    const created = spyOn(logger, method)
    spies.push(created)
    return created
  }
  afterEach(() => {
    for (const created of spies.splice(0)) created.mockRestore()
  })

  test('ungrouped last window keeps the fast path and its log metadata', () => {
    const info = spy('info')
    // session_group is empty, so the line ends in a separator.
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'solo', '1', ''])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('solo:@7')

    expect(calls).toEqual([
      ['display-message', '-t', 'solo:@7', '-p', expect.any(String)],
      ['kill-window', '-t', 'solo:@7'],
    ])
    expect(logged(info, 'window_killed')).toMatchObject({
      tmuxWindow: 'solo:@7',
      name: 'alpha',
      path: '/tmp/alpha',
    })
  })

  test('grouped non-last window keeps the fast path', () => {
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'cgl', '2', 'cgl'])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')

    expect(calls.map((call) => call[0])).toEqual(['display-message', 'kill-window'])
  })

  test('grouped last window kills the group with kill-session -g, never kill-window', () => {
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'cgl', '1', 'cgl'])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')

    expect(calls.map((call) => call[0])).toEqual(['display-message', 'list-sessions', 'kill-session'])
    expect(calls.at(-1)).toEqual(['kill-session', '-g', '-t', '=cgl'])
  })

  test('refuses the kill when the guard cannot read tmux', () => {
    const warn = spy('warn')
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'cgl', '1', 'cgl']),
      (argv) => {
        if (argv[0] === 'list-sessions') throw new TmuxTimeoutError('list-sessions', 3000)
        return undefined
      }
    )

    expect(() => new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')).toThrow(
      'refusing to kill last window of grouped session cgl: tmux list-sessions failed'
    )
    expect(calls.some((call) => call[0] === 'kill-window' || call[0] === 'kill-session')).toBe(false)
    expect(logged(warn, 'window_kill_group_refused')).toBeDefined()
  })

  test('probe timeout refuses the kill', () => {
    const warn = spy('warn')
    const { runTmux, calls } = recordingRunner(() => {
      throw new TmuxTimeoutError('display-message', 3000)
    })

    expect(() => new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')).toThrow(
      'Unable to verify tmux window cgl:@7 before kill: tmux display-message timed out after 3000ms'
    )
    expect(calls.map((call) => call[0])).toEqual(['display-message'])
    expect(logged(warn, 'window_kill_probe_failed')).toBeDefined()
  })

  test('unparseable probe output refuses the kill', () => {
    const { runTmux, calls } = recordingRunner('garbage\n')

    expect(() => new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')).toThrow(
      'Unable to verify tmux window cgl:@7 before kill: unparseable tmux probe output'
    )
    expect(calls.map((call) => call[0])).toEqual(['display-message'])
  })

  test('stale kill of a missing window refuses without touching the group', () => {
    // display-message describes the session's current window (@3) when the
    // requested @999 no longer exists.
    const { runTmux, calls } = recordingRunner(
      probe(['@3', '0', 'other', '/tmp/other', 'cgl', '1', 'cgl'])
    )

    expect(() => new SessionManager('agentboard', { runTmux }).killWindow('cgl:@999')).toThrow(
      'Unable to verify tmux window cgl:@999 before kill: window not found (tmux described @3)'
    )
    expect(calls.map((call) => call[0])).toEqual(['display-message'])
  })
})
