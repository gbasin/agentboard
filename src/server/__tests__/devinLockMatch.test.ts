// devinLockMatch.test.ts - lock-pid -> tmux window matching with stubbed ps/tmux
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchDevinLocksToWindows } from '../devinLockMatch'
import { config } from '../config'
import type { Session } from '../../shared/types'

// Fake `ps` and `tmux` on PATH: each prints <name>.out from the control dir,
// exits with <name>.code, sleeps <name>.sleep seconds first (or hangs when
// <name>.hang exists), and appends its
// argv to calls.log. No test ever reaches the real process table or tmux.
const FAKE = (name: string) => `#!/bin/sh
dir="$AB_DEVIN_FAKE_DIR"
printf '%s %s\\n' "${name}" "$*" >> "$dir/calls.log"
[ -f "$dir/${name}.hang" ] && exec sleep 5
if [ -f "$dir/${name}.sleep" ]; then
  sleep "$(cat "$dir/${name}.sleep")"
  printf '%s done\\n' "${name}" >> "$dir/calls.log"
fi
[ -f "$dir/${name}.out" ] && cat "$dir/${name}.out"
exit "$(cat "$dir/${name}.code" 2>/dev/null || echo 0)"
`

interface StubResult {
  exitCode: number
  stdout?: string
  sleepSeconds?: number
  hang?: boolean
}

const savedPath = process.env.PATH
const savedTimeout = config.tmuxTimeoutMs
const originalDevinCliDir = process.env.DEVIN_CLI_DIR
let binDir = ''
let cliDir = ''

function stub(name: 'ps' | 'tmux', result: StubResult) {
  fs.writeFileSync(path.join(binDir, `${name}.out`), result.stdout ?? '')
  fs.writeFileSync(path.join(binDir, `${name}.code`), String(result.exitCode))
  const sleepFile = path.join(binDir, `${name}.sleep`)
  if (result.sleepSeconds) fs.writeFileSync(sleepFile, String(result.sleepSeconds))
  else fs.rmSync(sleepFile, { force: true })
  const hangFile = path.join(binDir, `${name}.hang`)
  if (result.hang) fs.writeFileSync(hangFile, '')
  else fs.rmSync(hangFile, { force: true })
}

function calls(): string[] {
  try {
    return fs.readFileSync(path.join(binDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

beforeAll(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-devin-fakebin-'))
  fs.writeFileSync(path.join(binDir, 'ps'), FAKE('ps'), { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'tmux'), FAKE('tmux'), { mode: 0o755 })
  process.env.AB_DEVIN_FAKE_DIR = binDir
  process.env.PATH = `${binDir}:${savedPath ?? ''}`
})

afterAll(() => {
  process.env.PATH = savedPath
  delete process.env.AB_DEVIN_FAKE_DIR
  fs.rmSync(binDir, { recursive: true, force: true })
})

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
  fs.rmSync(path.join(binDir, 'calls.log'), { force: true })
  stub('ps', { exitCode: 0 })
  stub('tmux', { exitCode: 0 })
})

afterEach(() => {
  if (originalDevinCliDir !== undefined) process.env.DEVIN_CLI_DIR = originalDevinCliDir
  else delete process.env.DEVIN_CLI_DIR
  fs.rmSync(cliDir, { recursive: true, force: true })
})

describe('matchDevinLocksToWindows', () => {
  test('maps a devin pid descended from a pane pid to that window', async () => {
    // pane 100 -> shell 200 -> devin 300
    writeLock('sess-a', 300)
    stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [200, 100], [300, 200]]) })
    stub('tmux', { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) })
    const win = makeWindow('agentboard:@1')

    const matches = await matchDevinLocksToWindows([win])

    expect(matches.get('sess-a')).toBe(win)
    const tmuxCall = calls().find((c) => c.startsWith('tmux '))
    expect(tmuxCall).toContain('list-panes -a')
    expect(calls()).toContainEqual('ps -eo pid=,ppid=')
  })

  test('joins panes to windows on session_name:window_id', async () => {
    writeLock('sess-a', 300)
    writeLock('sess-b', 400)
    stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [110, 1], [300, 100], [400, 110]]) })
    // Same window id in two tmux sessions: only the exact session:id pair
    // that matches Session.tmuxWindow may claim the pane.
    stub('tmux', {
      exitCode: 0,
      stdout: paneLines([
        ['other', '@1', 100],
        ['agentboard', '@1', 110],
      ]),
    })
    const win = makeWindow('agentboard:@1')

    const matches = await matchDevinLocksToWindows([win])

    expect(matches.has('sess-a')).toBe(false)
    expect(matches.get('sess-b')).toBe(win)
  })

  test('covers non-active panes in a window', async () => {
    // Window @2 has two panes; devin runs under the second (non-active) one.
    writeLock('sess-a', 500)
    stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [101, 1], [500, 101]]) })
    stub('tmux', {
      exitCode: 0,
      stdout: paneLines([
        ['agentboard', '@2', 100],
        ['agentboard', '@2', 101],
      ]),
    })
    const win = makeWindow('agentboard:@2')

    expect((await matchDevinLocksToWindows([win])).get('sess-a')).toBe(win)
  })

  test('non-zero tmux exit yields no matches', async () => {
    writeLock('sess-a', 300)
    stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [300, 100]]) })
    stub('tmux', { exitCode: 1, stdout: paneLines([['agentboard', '@1', 100]]) })

    expect((await matchDevinLocksToWindows([makeWindow('agentboard:@1')])).size).toBe(0)
  })

  test('ps failure yields no matches', async () => {
    writeLock('sess-a', 300)
    stub('ps', { exitCode: 1, stdout: psLines([[100, 1], [300, 100]]) })
    stub('tmux', { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) })

    expect((await matchDevinLocksToWindows([makeWindow('agentboard:@1')])).size).toBe(0)
  })

  test('a hung ps is killed at the tmux timeout', async () => {
    config.tmuxTimeoutMs = 150
    try {
      writeLock('sess-a', 300)
      stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [300, 100]]), hang: true })
      stub('tmux', { exitCode: 0, stdout: paneLines([['agentboard', '@1', 100]]) })
      const startedAt = performance.now()
      expect((await matchDevinLocksToWindows([makeWindow('agentboard:@1')])).size).toBe(0)
      expect(performance.now() - startedAt).toBeLessThan(2000)
    } finally {
      config.tmuxTimeoutMs = savedTimeout
    }
  })

  test('runs ps and tmux concurrently without blocking the event loop', async () => {
    writeLock('sess-a', 300)
    stub('ps', { exitCode: 0, stdout: psLines([[100, 1], [300, 100]]), sleepSeconds: 0.3 })
    stub('tmux', {
      exitCode: 0,
      stdout: paneLines([['agentboard', '@1', 100]]),
      sleepSeconds: 0.3,
    })
    const win = makeWindow('agentboard:@1')

    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 20)
    try {
      // On the sync implementation this returns a Map, not a promise, after
      // blocking for both calls back to back.
      const pending = matchDevinLocksToWindows([win])
      expect(pending).toBeInstanceOf(Promise)
      expect((await pending).get('sess-a')).toBe(win)
    } finally {
      clearInterval(timer)
    }
    // The timer kept firing while both 300 ms calls were outstanding.
    expect(ticks).toBeGreaterThanOrEqual(5)
    // Both started before either finished: parallel, not in series.
    const log = calls()
    const firstDone = log.findIndex((line) => line.endsWith(' done'))
    expect(log.slice(0, firstDone).map((line) => line.split(' ')[0]).sort()).toEqual([
      'ps',
      'tmux',
    ])
  })

  test('no locks means no subprocesses', async () => {
    expect((await matchDevinLocksToWindows([makeWindow('agentboard:@1')])).size).toBe(0)
    expect(calls()).toHaveLength(0)
  })
})
