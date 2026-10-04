import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { logger } from '../logger'
import { SessionManager } from '../SessionManager'
import { buildTmuxFormat } from '../tmuxFormat'

// display-message output for KILL_TARGET_FORMAT: window_id, window_index,
// window_name, pane_current_path, session_name, session_windows,
// session_group. tmux prints a trailing newline.
const probe = (fields: string[]) => `${buildTmuxFormat(fields)}\n`

function recordingRunner(displayOutput: string) {
  const calls: string[][] = []
  const runTmux = (args: string[]): string => {
    const argv = args[0] === '-u' ? args.slice(1) : args
    calls.push(argv)
    if (argv[0] === 'display-message') return displayOutput
    return ''
  }
  return { runTmux, calls }
}

const killedLog = (info: ReturnType<typeof spyOn>) =>
  info.mock.calls.find((call: unknown[]) => call[0] === 'window_killed')?.[1]

describe('SessionManager.killWindow', () => {
  let info: ReturnType<typeof spyOn> | null = null
  afterEach(() => {
    info?.mockRestore()
    info = null
  })

  test('ungrouped last window keeps the fast path and its log metadata', () => {
    info = spyOn(logger, 'info')
    // session_group is empty, so the line ends in a separator.
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'solo', '1', ''])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('solo:@7')

    expect(calls.map((call) => call[0])).toEqual(['display-message', 'kill-window'])
    expect(killedLog(info)).toMatchObject({ tmuxWindow: 'solo:@7', path: '/tmp/alpha' })
    expect(killedLog(info)?.name).toBe('alpha')
  })

  test('grouped last window runs the guard before kill-window', () => {
    const { runTmux, calls } = recordingRunner(
      probe(['@7', '0', 'alpha', '/tmp/alpha', 'cgl', '1', 'cgl'])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('cgl:@7')

    const commands = calls.map((call) => call[0])
    expect(commands.indexOf('list-sessions')).toBeGreaterThan(0)
    expect(commands.at(-1)).toBe('kill-window')
  })

  test('stale kill of a missing window does not evacuate the group', () => {
    info = spyOn(logger, 'info')
    // display-message describes the session's current window (@3) when the
    // requested @999 no longer exists.
    const { runTmux, calls } = recordingRunner(
      probe(['@3', '0', 'other', '/tmp/other', 'cgl', '1', 'cgl'])
    )
    new SessionManager('agentboard', { runTmux }).killWindow('cgl:@999')

    expect(calls.map((call) => call[0])).toEqual(['display-message', 'kill-window'])
    // Metadata of the wrong window is not attributed to the kill.
    expect(killedLog(info)?.path).toBeUndefined()
  })
})
