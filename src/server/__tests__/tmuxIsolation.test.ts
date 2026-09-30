import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOW_NESTED_TMUX_ENV,
  applyNestedTmuxDecision,
  decideNestedTmux,
} from '../tmuxIsolation'

const LIVE_TMUX = '/private/tmp/tmux-501/default,23781,0'
const inManaged = () => ({ managed: true, session: 'agentboard' })
const inOwnTmux = () => ({ managed: false, session: 'main' })

describe('decideNestedTmux', () => {
  test('does nothing outside tmux', () => {
    expect(decideNestedTmux({})).toEqual({ action: 'none' })
    expect(decideNestedTmux({ TMUX: '  ' })).toEqual({ action: 'none' })
  })

  test('refuses inside an agentboard-managed pane', () => {
    const decision = decideNestedTmux({ TMUX: LIVE_TMUX, TMUX_PANE: '%1370' }, inManaged)
    expect(decision.action).toBe('refuse')
    if (decision.action !== 'refuse') throw new Error('unreachable')
    expect(decision.paneSession).toBe('agentboard')
    expect(decision.message).toContain('TMUX_TMPDIR')
    expect(decision.message).toContain(ALLOW_NESTED_TMUX_ENV)
  })

  test("allows running inside the user's own tmux session", () => {
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, TMUX_PANE: '%3' }, inOwnTmux)).toEqual({ action: 'none' })
  })

  test('passes the inherited pane to the probe', () => {
    const seen: Array<string | undefined> = []
    decideNestedTmux({ TMUX: LIVE_TMUX, TMUX_PANE: ' %7 ' }, (pane) => {
      seen.push(pane)
      return { managed: false, session: 'x' }
    })
    decideNestedTmux({ TMUX: LIVE_TMUX }, (pane) => {
      seen.push(pane)
      return { managed: false, session: 'x' }
    })
    expect(seen).toEqual(['%7', undefined])
  })

  test('skips the probe when isolation or opt-in is set', () => {
    const probe = () => {
      throw new Error('probe should not run')
    }
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, TMUX_TMPDIR: '/tmp/x' }, probe).action).toBe('isolate')
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, [ALLOW_NESTED_TMUX_ENV]: 'true' }, probe).action).toBe('allow')
  })

  test('isolates when TMUX_TMPDIR is set', () => {
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, TMUX_TMPDIR: '/tmp/ab-dev' })).toEqual({
      action: 'isolate',
      tmuxTmpDir: '/tmp/ab-dev',
      inheritedTmux: LIVE_TMUX,
    })
  })

  test('isolation wins over the explicit opt-in', () => {
    const decision = decideNestedTmux({
      TMUX: LIVE_TMUX,
      TMUX_TMPDIR: '/tmp/ab-dev',
      [ALLOW_NESTED_TMUX_ENV]: 'true',
    })
    expect(decision.action).toBe('isolate')
  })

  test('allows sharing the socket only on explicit opt-in', () => {
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, [ALLOW_NESTED_TMUX_ENV]: 'true' })).toEqual({
      action: 'allow',
      inheritedTmux: LIVE_TMUX,
    })
    expect(decideNestedTmux({ TMUX: LIVE_TMUX, [ALLOW_NESTED_TMUX_ENV]: '1' }, inManaged).action).toBe('refuse')
  })
})

describe('applyNestedTmuxDecision', () => {
  test('unsets TMUX and TMUX_PANE and creates TMUX_TMPDIR when isolating', () => {
    const root = mkdtempSync(join(tmpdir(), 'ab-iso-'))
    const socketDir = join(root, 'nested', 'sock')
    try {
      const env: Record<string, string | undefined> = {
        TMUX: LIVE_TMUX,
        TMUX_PANE: '%1370',
        TMUX_TMPDIR: socketDir,
      }
      expect(applyNestedTmuxDecision(env).action).toBe('isolate')
      expect(env.TMUX).toBeUndefined()
      expect(env.TMUX_PANE).toBeUndefined()
      expect(env.TMUX_TMPDIR).toBe(socketDir)
      expect(existsSync(socketDir)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('leaves env untouched otherwise', () => {
    const env: Record<string, string | undefined> = { TMUX: LIVE_TMUX, TMUX_PANE: '%1' }
    expect(applyNestedTmuxDecision(env, inManaged).action).toBe('refuse')
    expect(env).toEqual({ TMUX: LIVE_TMUX, TMUX_PANE: '%1' })
  })
})
