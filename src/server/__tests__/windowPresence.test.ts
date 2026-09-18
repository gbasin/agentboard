import { describe, expect, test } from 'bun:test'
import { SessionManager } from '../SessionManager'
import { TmuxTimeoutError } from '../tmuxTimeout'

describe('window presence checks', () => {
  test('uses list-panes with an exact session and validates every returned window ID', () => {
    const calls: string[][] = []
    const manager = new SessionManager('agentboard', {
      runTmux: (args) => {
        calls.push(args)
        return '@391\n@391\n'
      },
    })

    expect(manager.probeWindow('agentboard:@391')).toBe('present')
    expect(calls).toEqual([
      ['-u', 'list-panes', '-t', '=agentboard:@391', '-F', '#{window_id}'],
    ])
  })

  test.each(['', '@507\n', '@391\n@507\n', 'malformed\n'])(
    'treats unexpected output %j as uncertain',
    (output) => {
      const manager = new SessionManager('agentboard', { runTmux: () => output })
      expect(manager.probeWindow('agentboard:@391')).toBe('unknown')
    }
  )

  test.each([
    "can't find window: @391",
    "can't find session: agentboard",
    "can't find session: =agentboard",
  ])('recognizes explicit absence: %s', (message) => {
    const manager = new SessionManager('agentboard', {
      runTmux: () => { throw new Error(message) },
    })
    expect(manager.probeWindow('agentboard:@391')).toBe('absent')
  })

  test.each([
    new TmuxTimeoutError('list-panes', 3000),
    new Error('no server running on /tmp/tmux/default'),
    new Error('error connecting to tmux socket'),
    new Error("can't find window: @507"),
  ])('does not treat a failed or unrelated check as absence: %s', (error) => {
    const manager = new SessionManager('agentboard', {
      runTmux: () => { throw error },
    })
    expect(manager.probeWindow('agentboard:@391')).toBe('unknown')
  })

  test('does not query ambiguous window indexes', () => {
    const manager = new SessionManager('agentboard', {
      runTmux: () => { throw new Error('must not run') },
    })
    expect(manager.probeWindow('agentboard:1')).toBe('unknown')
  })
})
