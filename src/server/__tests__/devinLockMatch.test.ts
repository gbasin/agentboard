// devinLockMatch.test.ts - lock-pid -> tmux window matching with stubbed ps/tmux
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchDevinLocksToWindows } from '../devinLockMatch'
import { config } from '../config'
import type { Session } from '../../shared/types'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = Bun.spawnSync
const originalDevinCliDir = process.env.DEVIN_CLI_DIR

interface StubResult {
  exitCode: number
  stdout?: string
}

let cliDir = ''
let psResult: StubResult
let tmuxResult: StubResult
let calls: Array<{ cmd: string[]; timeout?: number }>

function spawnResult(result: StubResult) {
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout ?? ''),
    stderr: Buffer.from(''),
  } as ReturnType<typeof Bun.spawnSync>
}

function writeLock(sessionId: string, pid: number) {
  fs.writeFileSync(
    path.join(cliDir, 'session_locks', `${sessionId}.lock`),
    `${pid}\n`
  )
}

function makeWindow(tmuxWindow: string): Session {
  return {
    id: tmuxWindow,
    name: tmuxWindow,
    tmuxWindow,
    projectPath: '/tmp/project',
    status: 'waiting',
    lastActivity: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    source: 'managed',
  } as Session
}

function paneLines(rows: Array<[string, string, number]>): string {
  return rows.map((row) => row.join('\t')).join('\n') + '\n'
}

// pid -> ppid; 1 is launchd/init
function psLines(rows: Array<[number, number]>): string {
  return rows.map(([pid, ppid]) => `  ${pid}  ${ppid}`).join('\n') + '\n'
}

beforeEach(() => {
  cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-devin-locks-'))
  fs.mkdirSync(path.join(cliDir, 'session_locks'))
  process.env.DEVIN_CLI_DIR = cliDir
  calls = []
  psResult = { exitCode: 0, stdout: '' }
  tmuxResult = { exitCode: 0, stdout: '' }
  // timedSpawnSync always calls Bun.spawnSync(argv, options)
  bunAny.spawnSync = ((cmd: string[], options?: { timeout?: number }) => {
    calls.push({ cmd, timeout: options?.timeout })
    if (cmd[0] === 'ps') return spawnResult(psResult)
    if (cmd[0] === 'tmux') return spawnResult(tmuxResult)
    throw new Error(`unexpected spawn: ${cmd.join(' ')}`)
  }) as typeof Bun.spawnSync
})

afterEach(() => {
  bunAny.spawnSync = originalSpawnSync
  if (originalDevinCliDir) process.env.DEVIN_CLI_DIR = originalDevinCliDir
  else delete process.env.DEVIN_CLI_DIR
  fs.rmSync(cliDir, { recursive: true, force: true })
})

describe('matchDevinLocksToWindows', () => {
  test('maps a devin pid descended from a pane pid to that window', () => {
    // pane 100 -> shell 200 -> devin 300
    writeLock('sess-a', 300)
    psResult = {
      exitCode: 0,
      stdout: psLines([
        [100, 1],
        [200, 100],
        [300, 200],
      ]),
    }
    tmuxResult = { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) }
    const win = makeWindow('agentboard:@1')

    const matches = matchDevinLocksToWindows([win])

    expect(matches.get('sess-a')).toBe(win)
    const tmuxCall = calls.find((c) => c.cmd[0] === 'tmux')
    expect(tmuxCall?.cmd).toContain('list-panes')
    expect(tmuxCall?.cmd).toContain('-a')
  })

  test('joins panes to windows on session_name:window_id', () => {
    writeLock('sess-a', 300)
    writeLock('sess-b', 400)
    psResult = {
      exitCode: 0,
      stdout: psLines([
        [100, 1],
        [110, 1],
        [300, 100],
        [400, 110],
      ]),
    }
    // Same window id in two tmux sessions: only the exact session:id pair
    // that matches Session.tmuxWindow may claim the pane.
    tmuxResult = {
      exitCode: 0,
      stdout: paneLines([
        ['other', '@1', 100],
        ['agentboard', '@1', 110],
      ]),
    }
    const win = makeWindow('agentboard:@1')

    const matches = matchDevinLocksToWindows([win])

    expect(matches.has('sess-a')).toBe(false)
    expect(matches.get('sess-b')).toBe(win)
  })

  test('covers non-active panes in a window', () => {
    // Window @2 has two panes; devin runs under the second (non-active) one.
    writeLock('sess-a', 500)
    psResult = {
      exitCode: 0,
      stdout: psLines([
        [100, 1],
        [101, 1],
        [500, 101],
      ]),
    }
    tmuxResult = {
      exitCode: 0,
      stdout: paneLines([
        ['agentboard', '@2', 100],
        ['agentboard', '@2', 101],
      ]),
    }
    const win = makeWindow('agentboard:@2')

    expect(matchDevinLocksToWindows([win]).get('sess-a')).toBe(win)
  })

  test('non-zero tmux exit yields no matches', () => {
    writeLock('sess-a', 300)
    psResult = { exitCode: 0, stdout: psLines([[100, 1], [300, 100]]) }
    tmuxResult = {
      exitCode: 1,
      stdout: paneLines([['agentboard', '@1', 100]]),
    }

    expect(matchDevinLocksToWindows([makeWindow('agentboard:@1')]).size).toBe(0)
  })

  test('ps failure yields no matches and skips tmux', () => {
    writeLock('sess-a', 300)
    psResult = { exitCode: 1, stdout: '' }
    tmuxResult = { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) }

    expect(matchDevinLocksToWindows([makeWindow('agentboard:@1')]).size).toBe(0)
    expect(calls.some((c) => c.cmd[0] === 'tmux')).toBe(false)
  })

  test('bounds ps and tmux with the tmux timeout', () => {
    writeLock('sess-a', 300)
    psResult = { exitCode: 0, stdout: psLines([[100, 1], [300, 100]]) }
    tmuxResult = { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) }

    matchDevinLocksToWindows([makeWindow('agentboard:@1')])

    expect(calls.map((c) => c.cmd[0])).toEqual(['ps', 'tmux'])
    for (const call of calls) {
      expect(call.timeout).toBe(config.tmuxTimeoutMs)
    }
  })

  test('no locks means no subprocesses', () => {
    expect(matchDevinLocksToWindows([makeWindow('agentboard:@1')]).size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})
