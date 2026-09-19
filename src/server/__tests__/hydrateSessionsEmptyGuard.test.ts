// Missing discovery rows must not terminate sessions or detach live windows.
// This suite uses a temporary database and mocked tmux commands. The test
// runner isolates it because importing index.ts requires process-wide mocks.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import type { Session } from '../../shared/types'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
}

type TmuxCall = { args: readonly string[] }
// All `tmux ...` invocations observed, full argv including `tmux` and any
// flags like `-u`, so callers can filter without worrying about the position
// of the verb (which sits at index 1 or 2 depending on flags).
const tmuxCalls: TmuxCall[] = []
let probeResult: { exitCode: number; stdout: string; stderr: string; signalCode?: 'SIGTERM' } = {
  exitCode: 0, stdout: '', stderr: '',
}

function makeSpawnSyncMock(): typeof Bun.spawnSync {
  return ((...args: Parameters<typeof Bun.spawnSync>) => {
    const first = args[0] as unknown
    let cmdArr: string[] = []
    if (Array.isArray(first)) {
      cmdArr = first as string[]
    } else if (first && typeof first === 'object' && Array.isArray((first as { cmd?: unknown }).cmd)) {
      cmdArr = (first as { cmd: string[] }).cmd
    }
    if (cmdArr[0] === 'tmux') {
      tmuxCalls.push({ args: cmdArr })
      if (cmdArr.includes('list-panes')) {
        return {
          exitCode: probeResult.exitCode,
          stdout: Buffer.from(probeResult.stdout),
          stderr: Buffer.from(probeResult.stderr),
          signalCode: probeResult.signalCode,
        } as ReturnType<typeof Bun.spawnSync>
      }
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      success: true,
    } as unknown as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync
}

describe('hydrateSessionsWithAgentSessions — missing windows', () => {
  let hydrate: (sessions: Session[], opts?: unknown) => Session[]
  let tempDir: string
  let tempDbPath: string

  function visibleWindow(): Session {
    return {
      id: 'target:@400',
      tmuxWindow: 'target:@400',
      name: 'visible',
      projectPath: tempDir,
      status: 'working',
      lastActivity: '2026-09-18T20:00:25.000Z',
      createdAt: '2026-09-18T14:00:00.000Z',
      source: 'managed',
      agentType: 'claude',
    }
  }

  // Snapshots captured at beforeAll so we can fully restore in afterAll.
  let originalServe: typeof Bun.serve
  let originalSpawnSync: typeof Bun.spawnSync
  let originalSetInterval: typeof globalThis.setInterval
  const envSnapshot: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    'AGENTBOARD_DB_PATH',
    'LOG_FILE',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'AGENTBOARD_LOG_MATCH_WORKER',
    'NODE_ENV',
  ]

  function seedActiveSession(sessionId: string, currentWindow: string, displayName: string) {
    const seedDb = initDatabase({ path: tempDbPath })
    const now = new Date('2026-05-19T07:11:00.000Z').toISOString()
    const logPath = path.join(tempDir, `${sessionId}.jsonl`)
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '')
    }
    seedDb.insertSession({
      sessionId,
      logFilePath: logPath,
      projectPath: path.join(tempDir, sessionId),
      slug: null,
      agentType: 'claude',
      displayName,
      createdAt: now,
      lastActivityAt: now,
      lastUserMessage: null,
      currentWindow,
      isPinned: false,
      lastResumeError: null,
      wakeStartedAt: null,
      lastKnownLogSize: null,
      isCodexExec: false,
      launchCommand: null,
    })
    ;(seedDb as unknown as { db: { close: () => void } }).db.close()
  }

  beforeAll(async () => {
    // Snapshot env so we can restore exactly (including deletion).
    for (const k of ENV_KEYS) {
      envSnapshot[k] = process.env[k]
    }
    // Snapshot global mutables.
    originalServe = bunAny.serve
    originalSpawnSync = bunAny.spawnSync
    originalSetInterval = globalThis.setInterval

    // Prepare isolated dirs under tmpdir.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-hydrate-empty-guard-'))
    tempDbPath = path.join(tempDir, 'agentboard.db')
    const tempLogFile = path.join(tempDir, 'agentboard.log')
    const tempClaudeDir = path.join(tempDir, 'claude')
    const tempCodexDir = path.join(tempDir, 'codex')
    fs.mkdirSync(path.join(tempClaudeDir, 'projects'), { recursive: true })
    fs.mkdirSync(path.join(tempCodexDir, 'sessions'), { recursive: true })

    process.env.AGENTBOARD_DB_PATH = tempDbPath
    process.env.LOG_FILE = tempLogFile
    process.env.CLAUDE_CONFIG_DIR = tempClaudeDir
    process.env.CODEX_HOME = tempCodexDir
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    if (process.env.NODE_ENV === 'production' || !process.env.NODE_ENV) {
      process.env.NODE_ENV = 'test'
    }

    // Install mocks. The module under test creates a SessionManager on import
    // that captures Bun.spawnSync into an instance property, so the mock must
    // be in place before the import below evaluates.
    bunAny.spawnSync = makeSpawnSyncMock()
    bunAny.serve = ((_options: unknown) => ({} as unknown)) as unknown as typeof Bun.serve
    globalThis.setInterval = ((..._a: unknown[]) => 0) as unknown as typeof globalThis.setInterval

    // Import the module under test. Cache-buster forces a fresh evaluation
    // so we don't share module state across reruns.
    const mod = await import(
      `../index?test=hydrate-empty-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    hydrate = (mod as { hydrateSessionsWithAgentSessions: typeof hydrate }).hydrateSessionsWithAgentSessions
  })

  afterAll(() => {
    // Restore globals first so subsequent tests in this process see the real
    // Bun.spawnSync / Bun.serve / setInterval again.
    bunAny.serve = originalServe
    bunAny.spawnSync = originalSpawnSync
    globalThis.setInterval = originalSetInterval

    // Restore env keys to their original state (including deletion when the
    // key was originally unset).
    for (const k of ENV_KEYS) {
      const original = envSnapshot[k]
      if (original === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = original
      }
    }

    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    // Clear the shared DB so each test starts from a known state.
    const cleanDb = initDatabase({ path: tempDbPath })
    ;(cleanDb as unknown as { db: { exec: (sql: string) => void; close: () => void } })
      .db.exec('DELETE FROM agent_sessions')
    ;(cleanDb as unknown as { db: { close: () => void } }).db.close()
    tmuxCalls.length = 0
    probeResult = { exitCode: 0, stdout: '', stderr: '' }
  })

  test('does NOT call `tmux kill-window` when sessions=[] but DB has active sessions', () => {
    expect(typeof hydrate).toBe('function')

    // Seed: 5 active sessions, each currently bound to a live tmux window.
    for (let i = 1; i <= 5; i++) {
      seedActiveSession(`test-session-${i}`, `target:@${100 + i}`, `proj-${i}`)
    }

    // Sanity: confirm the SUT can see the seeded rows.
    const probeBefore = initDatabase({ path: tempDbPath })
    const activeBefore = probeBefore.getActiveSessions().length
    ;(probeBefore as unknown as { db: { close: () => void } }).db.close()
    expect(activeBefore).toBe(5)

    // Snapshot tmux calls *before* the call under test so we ignore any
    // bookkeeping calls the SUT made on import.
    const callCountBefore = tmuxCalls.length

    // Simulate the transient tmux-query failure that motivated this regression:
    // listWindows() returned an empty Session[] even though the DB still has
    // multiple active sessions pointing at live tmux windows.
    const result = hydrate([])
    expect(result).toHaveLength(5)
    expect(tmuxCalls.some((call) => call.args.includes('list-panes'))).toBe(false)

    // A `tmux kill-window` invocation has 'kill-window' as a verb in argv:
    //   ['tmux', 'kill-window', '-t', '<window>']           or
    //   ['tmux', '-u', 'kill-window', '-t', '<window>']
    const callsDuringHydrate = tmuxCalls.slice(callCountBefore)
    const killCalls = callsDuringHydrate.filter((c) => c.args.includes('kill-window'))

    expect(killCalls).toHaveLength(0)

    // DB rows must be preserved: a future regression could skip the kill but
    // still call db.orphanSession() and clear current_window. Pin both.
    const probeAfter = initDatabase({ path: tempDbPath })
    const activeAfter = probeAfter.getActiveSessions()
    ;(probeAfter as unknown as { db: { close: () => void } }).db.close()
    expect(activeAfter).toHaveLength(5)
    const windowsAfter = activeAfter.map((s) => s.currentWindow).sort()
    expect(windowsAfter).toEqual(
      Array.from({ length: 5 }, (_, i) => `target:@${100 + i + 1}`).sort()
    )
  })

  test('does NOT skip or kill when both sessions=[] and DB is empty (negative case)', () => {
    // DB starts empty (beforeEach deletes everything). hydrate([]) should
    // proceed normally: no kill calls, no warn, no orphaning. This pins the
    // contract that the guard only fires when activeSessions > 0 — otherwise
    // an empty-DB / empty-input call could regress into accidentally skipping
    // legitimate empty refreshes.
    const callCountBefore = tmuxCalls.length

    const result = hydrate([])

    const callsDuringHydrate = tmuxCalls.slice(callCountBefore)
    const killCalls = callsDuringHydrate.filter((c) => c.args.includes('kill-window'))
    expect(killCalls).toHaveLength(0)
    expect(result).toEqual([])
  })

  test('does NOT kill a live window omitted from a nonempty refresh snapshot', () => {
    seedActiveSession('visible-session', 'target:@400', 'visible')
    seedActiveSession('missing-session', 'target:@391', 'ike-home')
    probeResult.stdout = '@391\n'

    // The discovery snapshot contains one window. The other is still alive:
    // the tmux mock accepts commands against it, and no pane-dead check exists.
    const result = hydrate([visibleWindow()])

    const killCalls = tmuxCalls.filter((call) => call.args.includes('kill-window'))
    expect(killCalls).toEqual([])
    expect(result).toContainEqual(expect.objectContaining({
      tmuxWindow: 'target:@391',
      agentSessionId: 'missing-session',
      name: 'ike-home',
      status: 'unknown',
    }))

    const probe = initDatabase({ path: tempDbPath })
    const active = probe.getActiveSessions()
    ;(probe as unknown as { db: { close: () => void } }).db.close()
    expect(active.map((session) => session.currentWindow).sort()).toEqual([
      'target:@391',
      'target:@400',
    ])

    // The next complete snapshot restores status without duplicating a row.
    tmuxCalls.length = 0
    const recovered = hydrate(result.map((session) => ({ ...session, status: 'working' })))
    expect(recovered).toHaveLength(2)
    expect(recovered.find((session) => session.tmuxWindow === 'target:@391')?.status)
      .toBe('working')
    expect(tmuxCalls).toHaveLength(0)
  })

  test.each(['connection error', 'timeout'])('preserves sessions with at most one failing probe on %s', (failure) => {
    seedActiveSession('uncertain', 'target:@391', 'ike-home')
    for (let i = 0; i < 9; i++) {
      seedActiveSession(`other-${i}`, `target:@${600 + i}`, `other-${i}`)
    }
    probeResult = { exitCode: 1, stdout: '', stderr: 'error connecting to tmux socket' }
    if (failure === 'timeout') probeResult.signalCode = 'SIGTERM'

    const result = hydrate([visibleWindow()])

    expect(result).toHaveLength(11)
    expect(new Set(result.map((session) => session.id)).size).toBe(11)
    expect(result).toContainEqual(expect.objectContaining({
      tmuxWindow: 'target:@391',
      agentSessionId: 'uncertain',
      name: 'ike-home',
    }))
    expect(tmuxCalls.some((call) => call.args.includes('kill-window'))).toBe(false)
    expect(tmuxCalls.filter((call) => call.args.includes('list-panes'))).toHaveLength(1)
    const probe = initDatabase({ path: tempDbPath })
    expect(probe.getActiveSessions()).toHaveLength(10)
    ;(probe as unknown as { db: { close: () => void } }).db.close()
  })

  test('orphans a confirmed missing window without issuing a kill command', () => {
    seedActiveSession('gone', 'target:@391', 'ike-home')
    probeResult = { exitCode: 1, stdout: '', stderr: "can't find window: @391\n" }

    expect(hydrate([visibleWindow()])).toEqual([visibleWindow()])

    expect(tmuxCalls.some((call) => call.args.includes('kill-window'))).toBe(false)
    const probe = initDatabase({ path: tempDbPath })
    expect(probe.getActiveSessions()).toHaveLength(0)
    ;(probe as unknown as { db: { close: () => void } }).db.close()
  })
})
