import { describe, expect, test, afterEach } from 'bun:test'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { initDatabase } from '../db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentType } from '../../shared/types'

const now = new Date('2026-01-01T00:00:00.000Z').toISOString()

function makeSession(overrides: Partial<{
  sessionId: string
  logFilePath: string
  projectPath: string
  slug: string | null
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  lastUserMessage: string | null
  currentWindow: string | null
  isPinned: boolean
  lastResumeError: string | null
  lastResumeAttemptAt: string | null
  lastKnownLogSize: number | null
  isCodexExec: boolean
  launchCommand: string | null
}> = {}) {
  return {
    sessionId: 'session-abc',
    logFilePath: '/tmp/session-abc.jsonl',
    projectPath: '/tmp/alpha',
    slug: null as string | null,
    agentType: 'claude' as const,
    displayName: 'alpha',
    createdAt: now,
    lastActivityAt: now,
    lastUserMessage: null,
    currentWindow: 'agentboard:1',
    isPinned: false,
    lastResumeError: null,
    lastResumeAttemptAt: null,
    lastKnownLogSize: null,
    isCodexExec: false,
    launchCommand: null,
    ...overrides,
  }
}

describe('db', () => {
  const db = initDatabase({ path: ':memory:' })

  afterEach(() => {
    db.db.exec('DELETE FROM agent_sessions')
  })

  test('insert/get/update/orphan session records', () => {
    const session = makeSession()
    const inserted = db.insertSession(session)
    expect(inserted.id).toBeGreaterThan(0)
    expect(inserted.sessionId).toBe(session.sessionId)

    const byId = db.getSessionById(session.sessionId)
    expect(byId?.logFilePath).toBe(session.logFilePath)

    const byPath = db.getSessionByLogPath(session.logFilePath)
    expect(byPath?.sessionId).toBe(session.sessionId)

    const byWindow = db.getSessionByWindow(session.currentWindow ?? '')
    expect(byWindow?.sessionId).toBe(session.sessionId)

    const updated = db.updateSession(session.sessionId, {
      displayName: 'beta',
      currentWindow: null,
    })
    expect(updated?.displayName).toBe('beta')
    expect(updated?.currentWindow).toBeNull()

    const active = db.getActiveSessions()
    const inactive = db.getHistorySessions()
    expect(active).toHaveLength(0)
    expect(inactive).toHaveLength(1)

    const orphaned = db.orphanSession(session.sessionId)
    expect(orphaned?.currentWindow).toBeNull()
  })

  test('setPinned updates is_pinned flag', () => {
    const session = makeSession()
    db.insertSession(session)

    // Initially not pinned
    expect(db.getSessionById(session.sessionId)?.isPinned).toBe(false)

    // Pin it
    const pinned = db.setPinned(session.sessionId, true)
    expect(pinned?.isPinned).toBe(true)
    expect(db.getSessionById(session.sessionId)?.isPinned).toBe(true)

    // Unpin it
    const unpinned = db.setPinned(session.sessionId, false)
    expect(unpinned?.isPinned).toBe(false)
    expect(db.getSessionById(session.sessionId)?.isPinned).toBe(false)
  })

  test('getHibernatingSessions returns marked sessions without window', () => {
    // Marked + orphaned (should be returned)
    db.insertSession(makeSession({
      sessionId: 'a',
      logFilePath: '/tmp/a.jsonl',
      isPinned: true,
      currentWindow: null,
    }))
    // Marked + active (should NOT be returned)
    db.insertSession(makeSession({
      sessionId: 'b',
      logFilePath: '/tmp/b.jsonl',
      isPinned: true,
      currentWindow: 'agentboard:1',
    }))
    // Unmarked + orphaned (should NOT be returned)
    db.insertSession(makeSession({
      sessionId: 'c',
      logFilePath: '/tmp/c.jsonl',
      isPinned: false,
      currentWindow: null,
    }))

    const hibernating = db.getHibernatingSessions()
    expect(hibernating).toHaveLength(1)
    expect(hibernating[0].sessionId).toBe('a')
  })

  test('hibernating sessions are derived from marked sessions without windows', () => {
    db.insertSession(makeSession({
      sessionId: 'hibernating-one',
      logFilePath: '/tmp/hibernating-one.jsonl',
      currentWindow: null,
      isPinned: true,
    }))
    db.insertSession(makeSession({
      sessionId: 'history-one',
      logFilePath: '/tmp/history-one.jsonl',
      currentWindow: null,
      isPinned: false,
    }))

    const hibernating = db.getHibernatingSessions()
    const history = db.getHistorySessions()

    expect(hibernating.map((session) => session.sessionId)).toEqual(['hibernating-one'])
    expect(history.map((session) => session.sessionId)).toEqual(['history-one'])
  })

  test('orphanSession preserves hibernation marker state', () => {
    db.insertSession(makeSession({
      sessionId: 'marked-to-orphan',
      logFilePath: '/tmp/marked-to-orphan.jsonl',
      currentWindow: 'agentboard:9',
      isPinned: true,
    }))

    const orphaned = db.orphanSession('marked-to-orphan')

    expect(orphaned?.currentWindow).toBeNull()
    expect(orphaned?.isPinned).toBe(true)
  })

  test('displayNameExists returns true for existing names', () => {
    const uniqueName = `test-name-${Date.now()}`
    const session = makeSession({
      sessionId: `session-${Date.now()}`,
      logFilePath: `/tmp/session-${Date.now()}.jsonl`,
      displayName: uniqueName,
    })
    db.insertSession(session)

    expect(db.displayNameExists(uniqueName)).toBe(true)
    expect(db.displayNameExists('definitely-nonexistent-xyz123')).toBe(false)
  })

  test('migrates legacy schema without session_source', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const dbPath = path.join(tempDir, 'agentboard.db')
    const legacyDb = new SQLiteDatabase(dbPath)

    legacyDb.exec(`
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        log_file_path TEXT NOT NULL UNIQUE,
        project_path TEXT,
        agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex', 'pi')),
        display_name TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        current_window TEXT,
        session_source TEXT NOT NULL CHECK (session_source IN ('log', 'synthetic'))
      );
    `)

    legacyDb.exec(`
      INSERT INTO agent_sessions (
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        current_window,
        session_source
      ) VALUES
        ('session-log', '/tmp/log.jsonl', '/tmp/project', 'claude', 'log', '${now}', '${now}', null, 'log'),
        ('session-synthetic', '/tmp/synth.jsonl', '/tmp/project', 'claude', 'synthetic', '${now}', '${now}', null, 'synthetic');
    `)
    legacyDb.close()

    const migrated = initDatabase({ path: dbPath })
    const columns = migrated.db
      .prepare('PRAGMA table_info(agent_sessions)')
      .all() as Array<{ name?: string }>
    const columnNames = columns.map((column) => String(column.name ?? ''))

    expect(columnNames).not.toContain('session_source')
    expect(columnNames).toContain('last_user_message')
    expect(migrated.getSessionById('session-log')).not.toBeNull()
    expect(migrated.getSessionById('session-synthetic')).toBeNull()

    migrated.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('migratePiAgentType preserves launchCommand during table rebuild', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const dbPath = path.join(tempDir, 'agentboard.db')
    const legacyDb = new SQLiteDatabase(dbPath)

    legacyDb.exec(`
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        log_file_path TEXT NOT NULL UNIQUE,
        project_path TEXT,
        slug TEXT,
        agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex')),
        display_name TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        last_user_message TEXT,
        current_window TEXT,
        is_sleeping INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        last_resume_error TEXT,
        last_known_log_size INTEGER,
        is_codex_exec INTEGER NOT NULL DEFAULT 0,
        launch_command TEXT
      );
    `)

    legacyDb.exec(`
      INSERT INTO agent_sessions (
        session_id,
        log_file_path,
        project_path,
        slug,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_sleeping,
        is_pinned,
        last_resume_error,
        last_known_log_size,
        is_codex_exec,
        launch_command
      ) VALUES (
        'legacy-launch-command',
        '/tmp/legacy-launch-command.jsonl',
        '/tmp/project',
        null,
        'claude',
        'legacy',
        '${now}',
        '${now}',
        'continue',
        null,
        0,
        0,
        null,
        null,
        0,
        'codex --dangerously-bypass-approvals-and-sandbox'
      );
    `)
    legacyDb.close()

    const migrated = initDatabase({ path: dbPath })
    const session = migrated.getSessionById('legacy-launch-command')

    expect(session?.launchCommand).toBe(
      'codex --dangerously-bypass-approvals-and-sandbox'
    )

    migrated.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('migrates legacy sleeping flag into hibernating marker state', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-'))
    const dbPath = path.join(tempDir, 'agentboard.db')
    const legacyDb = new SQLiteDatabase(dbPath)

    legacyDb.exec(`
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE,
        log_file_path TEXT NOT NULL UNIQUE,
        project_path TEXT,
        slug TEXT,
        agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex', 'pi')),
        display_name TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        last_user_message TEXT,
        current_window TEXT,
        is_sleeping INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        last_resume_error TEXT,
        last_known_log_size INTEGER,
        is_codex_exec INTEGER NOT NULL DEFAULT 0,
        launch_command TEXT
      );
    `)

    legacyDb.exec(`
      INSERT INTO agent_sessions (
        session_id,
        log_file_path,
        project_path,
        slug,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_sleeping,
        is_pinned,
        last_resume_error,
        last_known_log_size,
        is_codex_exec,
        launch_command
      ) VALUES
        ('legacy-hibernating', '/tmp/legacy-hibernating.jsonl', '/tmp/project', null, 'claude', 'hibernating', '${now}', '${now}', null, null, 1, 0, null, null, 0, null),
        ('legacy-history', '/tmp/legacy-history.jsonl', '/tmp/project', null, 'claude', 'history', '${now}', '${now}', null, null, 0, 0, null, null, 0, null);
    `)
    legacyDb.close()

    const migrated = initDatabase({ path: dbPath })
    const columns = migrated.db
      .prepare('PRAGMA table_info(agent_sessions)')
      .all() as Array<{ name?: string }>
    const columnNames = columns.map((column) => String(column.name ?? ''))

    expect(columnNames).not.toContain('is_sleeping')
    expect(columnNames).toContain('last_resume_attempt_at')
    expect(migrated.getSessionById('legacy-hibernating')?.isPinned).toBe(true)
    expect(migrated.getHibernatingSessions().map((session) => session.sessionId)).toEqual([
      'legacy-hibernating',
    ])
    expect(migrated.getHistorySessions().map((session) => session.sessionId)).toEqual([
      'legacy-history',
    ])

    migrated.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('launchCommand is stored and retrieved', () => {
    const session = makeSession({
      sessionId: 'launch-cmd-test',
      logFilePath: '/tmp/launch-cmd.jsonl',
      launchCommand: 'claude --dangerously-skip-permissions',
    })
    const inserted = db.insertSession(session)
    expect(inserted.launchCommand).toBe('claude --dangerously-skip-permissions')

    const fetched = db.getSessionById('launch-cmd-test')
    expect(fetched?.launchCommand).toBe('claude --dangerously-skip-permissions')

    // Update launchCommand
    const updated = db.updateSession('launch-cmd-test', {
      launchCommand: 'claude --model opus --dangerously-skip-permissions',
    })
    expect(updated?.launchCommand).toBe('claude --model opus --dangerously-skip-permissions')

    // Null launchCommand (default)
    const session2 = makeSession({
      sessionId: 'no-launch-cmd',
      logFilePath: '/tmp/no-launch-cmd.jsonl',
      launchCommand: null,
    })
    const inserted2 = db.insertSession(session2)
    expect(inserted2.launchCommand).toBeNull()
  })

  test('getActiveSessions returns results in deterministic order by session_id', () => {
    // Insert sessions with session_ids that would sort differently than insertion order
    db.insertSession(makeSession({
      sessionId: 'zebra',
      logFilePath: '/tmp/zebra.jsonl',
      displayName: 'zebra',
      currentWindow: 'agentboard:3',
    }))
    db.insertSession(makeSession({
      sessionId: 'alpha',
      logFilePath: '/tmp/alpha.jsonl',
      displayName: 'alpha',
      currentWindow: 'agentboard:1',
    }))
    db.insertSession(makeSession({
      sessionId: 'middle',
      logFilePath: '/tmp/middle.jsonl',
      displayName: 'middle',
      currentWindow: 'agentboard:2',
    }))

    const active = db.getActiveSessions()
    expect(active).toHaveLength(3)
    expect(active[0].sessionId).toBe('alpha')
    expect(active[1].sessionId).toBe('middle')
    expect(active[2].sessionId).toBe('zebra')
  })

  test('getHistorySessions returns results ordered by last_activity_at DESC with session_id tiebreaker', () => {
    const recent = '2026-01-02T00:00:00.000Z'
    const older = '2026-01-01T00:00:00.000Z'

    // Two sessions with the same last_activity_at to test the tiebreaker
    db.insertSession(makeSession({
      sessionId: 'tie-zebra',
      logFilePath: '/tmp/tie-zebra.jsonl',
      displayName: 'tie-zebra',
      currentWindow: null,
      lastActivityAt: older,
    }))
    db.insertSession(makeSession({
      sessionId: 'tie-alpha',
      logFilePath: '/tmp/tie-alpha.jsonl',
      displayName: 'tie-alpha',
      currentWindow: null,
      lastActivityAt: older,
    }))
    // One session with more recent activity (should come first)
    db.insertSession(makeSession({
      sessionId: 'recent-one',
      logFilePath: '/tmp/recent.jsonl',
      displayName: 'recent',
      currentWindow: null,
      lastActivityAt: recent,
    }))

    const history = db.getHistorySessions()
    expect(history).toHaveLength(3)
    // Most recent activity first
    expect(history[0].sessionId).toBe('recent-one')
    // Same activity timestamp: alphabetical session_id tiebreaker
    expect(history[1].sessionId).toBe('tie-alpha')
    expect(history[2].sessionId).toBe('tie-zebra')
  })

  test('getHistorySessions with maxAgeHours also uses session_id tiebreaker', () => {
    const now = new Date()
    const recentTime = new Date(now.getTime() - 30 * 60 * 1000).toISOString() // 30 min ago

    db.insertSession(makeSession({
      sessionId: 'age-zebra',
      logFilePath: '/tmp/age-zebra.jsonl',
      displayName: 'age-zebra',
      currentWindow: null,
      lastActivityAt: recentTime,
    }))
    db.insertSession(makeSession({
      sessionId: 'age-alpha',
      logFilePath: '/tmp/age-alpha.jsonl',
      displayName: 'age-alpha',
      currentWindow: null,
      lastActivityAt: recentTime,
    }))

    const history = db.getHistorySessions({ maxAgeHours: 1 })
    expect(history).toHaveLength(2)
    // Same timestamp: alphabetical session_id tiebreaker
    expect(history[0].sessionId).toBe('age-alpha')
    expect(history[1].sessionId).toBe('age-zebra')
  })

  test('app settings get/set', () => {
    // Initially null
    expect(db.getAppSetting('test_key')).toBeNull()

    // Set a value
    db.setAppSetting('test_key', 'test_value')
    expect(db.getAppSetting('test_key')).toBe('test_value')

    // Update the value
    db.setAppSetting('test_key', 'updated_value')
    expect(db.getAppSetting('test_key')).toBe('updated_value')

    // Different key
    db.setAppSetting('another_key', 'another_value')
    expect(db.getAppSetting('another_key')).toBe('another_value')
    expect(db.getAppSetting('test_key')).toBe('updated_value')

    // Cleanup
    db.db.exec("DELETE FROM app_settings WHERE key = 'test_key'")
    db.db.exec("DELETE FROM app_settings WHERE key = 'another_key'")
  })
})
