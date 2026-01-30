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
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  lastUserMessage: string | null
  currentWindow: string | null
  isPinned: boolean
  lastResumeError: string | null
  lastKnownLogSize: number | null
  isCodexExec: boolean
}> = {}) {
  return {
    sessionId: 'session-abc',
    logFilePath: '/tmp/session-abc.jsonl',
    projectPath: '/tmp/alpha',
    agentType: 'claude' as const,
    displayName: 'alpha',
    createdAt: now,
    lastActivityAt: now,
    lastUserMessage: null,
    currentWindow: 'agentboard:1',
    isPinned: false,
    lastResumeError: null,
    lastKnownLogSize: null,
    isCodexExec: false,
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
    const inactive = db.getInactiveSessions()
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

  test('getPinnedOrphaned returns pinned sessions without window', () => {
    // Pinned + orphaned (should be returned)
    db.insertSession(makeSession({
      sessionId: 'a',
      logFilePath: '/tmp/a.jsonl',
      isPinned: true,
      currentWindow: null,
    }))
    // Pinned + active (should NOT be returned)
    db.insertSession(makeSession({
      sessionId: 'b',
      logFilePath: '/tmp/b.jsonl',
      isPinned: true,
      currentWindow: 'agentboard:1',
    }))
    // Not pinned + orphaned (should NOT be returned)
    db.insertSession(makeSession({
      sessionId: 'c',
      logFilePath: '/tmp/c.jsonl',
      isPinned: false,
      currentWindow: null,
    }))

    const orphaned = db.getPinnedOrphaned()
    expect(orphaned).toHaveLength(1)
    expect(orphaned[0].sessionId).toBe('a')
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
        agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex')),
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
