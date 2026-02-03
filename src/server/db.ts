import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import type { AgentType } from '../shared/types'
import { resolveProjectPath } from './paths'

export interface AgentSessionRecord {
  id: number
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
}

export interface SessionDatabase {
  db: SQLiteDatabase
  insertSession: (session: Omit<AgentSessionRecord, 'id'>) => AgentSessionRecord
  updateSession: (
    sessionId: string,
    patch: Partial<Omit<AgentSessionRecord, 'id' | 'sessionId'>>
  ) => AgentSessionRecord | null
  getSessionById: (sessionId: string) => AgentSessionRecord | null
  getSessionByLogPath: (logPath: string) => AgentSessionRecord | null
  getSessionByWindow: (tmuxWindow: string) => AgentSessionRecord | null
  getActiveSessions: () => AgentSessionRecord[]
  getInactiveSessions: (options?: { maxAgeHours?: number }) => AgentSessionRecord[]
  orphanSession: (sessionId: string) => AgentSessionRecord | null
  displayNameExists: (displayName: string, excludeSessionId?: string) => boolean
  setPinned: (sessionId: string, isPinned: boolean) => AgentSessionRecord | null
  getPinnedOrphaned: () => AgentSessionRecord[]
  // App settings
  getAppSetting: (key: string) => string | null
  setAppSetting: (key: string, value: string) => void
  close: () => void
}

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.agentboard'
)
const DEFAULT_DB_PATH = path.join(DEFAULT_DATA_DIR, 'agentboard.db')
const DB_PATH_ENV = 'AGENTBOARD_DB_PATH'

const AGENT_SESSIONS_COLUMNS_SQL = `
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  log_file_path TEXT NOT NULL UNIQUE,
  project_path TEXT,
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex', 'pi')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_user_message TEXT,
  current_window TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0,
  last_resume_error TEXT,
  -- NULL means "unknown" (e.g., after upgrade). First poll will initialize to actual size.
  -- This triggers a one-time match check for upgraded sessions.
  last_known_log_size INTEGER,
  is_codex_exec INTEGER NOT NULL DEFAULT 0
`

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
${AGENT_SESSIONS_COLUMNS_SQL}
);
`

const CREATE_APP_SETTINGS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const CREATE_INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_session_id
  ON agent_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_log_file_path
  ON agent_sessions (log_file_path);
CREATE INDEX IF NOT EXISTS idx_current_window
  ON agent_sessions (current_window);
`

export function initDatabase(options: { path?: string } = {}): SessionDatabase {
  const envPath = process.env[DB_PATH_ENV]?.trim()
  const resolvedEnvPath =
    envPath && envPath !== ':memory:' ? resolveProjectPath(envPath) : envPath
  const dbPath = options.path ?? resolvedEnvPath ?? DEFAULT_DB_PATH
  ensureDataDir(dbPath)

  const db = new SQLiteDatabase(dbPath)
  migrateDatabase(db)
  db.exec(CREATE_TABLE_SQL)
  db.exec(CREATE_INDEXES_SQL)
  db.exec(CREATE_APP_SETTINGS_TABLE_SQL)
  migrateLastUserMessageColumn(db)
  migrateDeduplicateDisplayNames(db)
  migrateIsPinnedColumn(db)
  migrateLastResumeErrorColumn(db)
  migrateLastKnownLogSizeColumn(db)
  migrateIsCodexExecColumn(db)
  migratePiAgentType(db)

  const insertStmt = db.prepare(
    `INSERT INTO agent_sessions
      (session_id, log_file_path, project_path, agent_type, display_name, created_at, last_activity_at, last_user_message, current_window, is_pinned, last_resume_error, last_known_log_size, is_codex_exec)
     VALUES ($sessionId, $logFilePath, $projectPath, $agentType, $displayName, $createdAt, $lastActivityAt, $lastUserMessage, $currentWindow, $isPinned, $lastResumeError, $lastKnownLogSize, $isCodexExec)`
  )

  const selectBySessionId = db.prepare(
    'SELECT * FROM agent_sessions WHERE session_id = $sessionId'
  )
  const selectByLogPath = db.prepare(
    'SELECT * FROM agent_sessions WHERE log_file_path = $logFilePath'
  )
  const selectByWindow = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window = $currentWindow'
  )
  const selectActive = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NOT NULL'
  )
  const selectInactive = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL ORDER BY last_activity_at DESC'
  )
  const selectInactiveRecent = db.prepare(
    'SELECT * FROM agent_sessions WHERE current_window IS NULL AND last_activity_at > $cutoff ORDER BY last_activity_at DESC'
  )
  const selectByDisplayName = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName LIMIT 1'
  )
  const selectByDisplayNameExcluding = db.prepare(
    'SELECT 1 FROM agent_sessions WHERE display_name = $displayName AND session_id != $excludeSessionId LIMIT 1'
  )

  const updateStmt = (fields: string[]) =>
    db.prepare(
      `UPDATE agent_sessions SET ${fields
        .map((field) => `${field} = $${field}`)
        .join(', ')} WHERE session_id = $sessionId`
    )

  // App settings prepared statements
  const selectAppSetting = db.prepare(
    'SELECT value FROM app_settings WHERE key = $key'
  )
  const upsertAppSetting = db.prepare(
    'INSERT OR REPLACE INTO app_settings (key, value) VALUES ($key, $value)'
  )

  return {
    db,
    insertSession: (session) => {
      insertStmt.run({
        $sessionId: session.sessionId,
        $logFilePath: session.logFilePath,
        $projectPath: session.projectPath,
        $agentType: session.agentType,
        $displayName: session.displayName,
        $createdAt: session.createdAt,
        $lastActivityAt: session.lastActivityAt,
        $lastUserMessage: session.lastUserMessage,
        $currentWindow: session.currentWindow,
        $isPinned: session.isPinned ? 1 : 0,
        $lastResumeError: session.lastResumeError,
        $lastKnownLogSize: session.lastKnownLogSize,
        $isCodexExec: session.isCodexExec ? 1 : 0,
      })
      const row = selectBySessionId.get({ $sessionId: session.sessionId }) as
        | Record<string, unknown>
        | undefined
      if (!row) {
        throw new Error('Failed to insert session')
      }
      return mapRow(row)
    },
    updateSession: (sessionId, patch) => {
      const entries = Object.entries(patch).filter(
        ([, value]) => value !== undefined
      ) as Array<[string, unknown]>
      if (entries.length === 0) {
        return (selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown> | undefined)
          ? mapRow(selectBySessionId.get({ $sessionId: sessionId }) as Record<string, unknown>)
          : null
      }

      const fieldMap: Record<string, string> = {
        logFilePath: 'log_file_path',
        projectPath: 'project_path',
        agentType: 'agent_type',
        displayName: 'display_name',
        createdAt: 'created_at',
        lastActivityAt: 'last_activity_at',
        lastUserMessage: 'last_user_message',
        currentWindow: 'current_window',
        isPinned: 'is_pinned',
        lastResumeError: 'last_resume_error',
        lastKnownLogSize: 'last_known_log_size',
        isCodexExec: 'is_codex_exec',
      }

      const fields: string[] = []
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
      }
      for (const [key, value] of entries) {
        const field = fieldMap[key]
        if (!field) continue
        fields.push(field)
        // Normalize boolean fields to 0/1 for SQLite
        if (key === 'isPinned' || key === 'isCodexExec') {
          params[`$${field}`] = value ? 1 : 0
        } else {
          params[`$${field}`] = value as string | number | null
        }
      }

      if (fields.length === 0) {
        return null
      }

      updateStmt(fields).run(params)
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionById: (sessionId) => {
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByLogPath: (logPath) => {
      const row = selectByLogPath.get({ $logFilePath: logPath }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getSessionByWindow: (tmuxWindow) => {
      const row = selectByWindow.get({ $currentWindow: tmuxWindow }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getActiveSessions: () => {
      const rows = selectActive.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    getInactiveSessions: (options?: { maxAgeHours?: number }) => {
      if (options?.maxAgeHours) {
        const cutoff = new Date(Date.now() - options.maxAgeHours * 60 * 60 * 1000).toISOString()
        const rows = selectInactiveRecent.all({ $cutoff: cutoff }) as Record<string, unknown>[]
        return rows.map(mapRow)
      }
      const rows = selectInactive.all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    orphanSession: (sessionId) => {
      updateStmt(['current_window']).run({
        $sessionId: sessionId,
        $current_window: null,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    displayNameExists: (displayName, excludeSessionId) => {
      const row = excludeSessionId
        ? selectByDisplayNameExcluding.get({
            $displayName: displayName,
            $excludeSessionId: excludeSessionId,
          })
        : selectByDisplayName.get({ $displayName: displayName })
      return row != null
    },
    setPinned: (sessionId, isPinned) => {
      updateStmt(['is_pinned']).run({
        $sessionId: sessionId,
        $is_pinned: isPinned ? 1 : 0,
      })
      const row = selectBySessionId.get({ $sessionId: sessionId }) as
        | Record<string, unknown>
        | undefined
      return row ? mapRow(row) : null
    },
    getPinnedOrphaned: () => {
      const rows = db
        .prepare(
          'SELECT * FROM agent_sessions WHERE is_pinned = 1 AND current_window IS NULL ORDER BY last_activity_at DESC'
        )
        .all() as Record<string, unknown>[]
      return rows.map(mapRow)
    },
    // App settings
    getAppSetting: (key) => {
      const row = selectAppSetting.get({ $key: key }) as
        | { value: string }
        | undefined
      return row?.value ?? null
    },
    setAppSetting: (key, value) => {
      upsertAppSetting.run({ $key: key, $value: value })
    },
    close: () => {
      db.close()
    },
  }
}

function ensureDataDir(dbPath: string) {
  if (dbPath === ':memory:') {
    return
  }

  const dir = path.dirname(dbPath)
  if (!dir) return

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    // Ignore mkdir failures; SQLite will surface errors when opening
  }

  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Ignore chmod failures
  }
}

function mapRow(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    logFilePath: String(row.log_file_path ?? ''),
    projectPath: String(row.project_path ?? ''),
    agentType: row.agent_type as AgentType,
    displayName: String(row.display_name ?? ''),
    createdAt: String(row.created_at ?? ''),
    lastActivityAt: String(row.last_activity_at ?? ''),
    lastUserMessage:
      row.last_user_message === null || row.last_user_message === undefined
        ? null
        : String(row.last_user_message),
    currentWindow:
      row.current_window === null || row.current_window === undefined
        ? null
        : String(row.current_window),
    isPinned: Number(row.is_pinned) === 1,
    lastResumeError:
      row.last_resume_error === null || row.last_resume_error === undefined
        ? null
        : String(row.last_resume_error),
    // Note: null lastKnownLogSize is treated as "unknown", triggering a match check
    // on first poll after upgrade. This is intentional (one-time cost).
    lastKnownLogSize:
      row.last_known_log_size === null || row.last_known_log_size === undefined
        ? null
        : Number(row.last_known_log_size),
    isCodexExec: Number(row.is_codex_exec) === 1,
  }
}

function migrateDatabase(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || !columns.includes('session_source')) {
    return
  }

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE agent_sessions RENAME TO agent_sessions_old')
    createAgentSessionsTable(db, 'agent_sessions')
    db.exec(`
      INSERT INTO agent_sessions (
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window
      )
      SELECT
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        NULL AS last_user_message,
        current_window
      FROM agent_sessions_old
      WHERE session_source = 'log'
    `)
    db.exec('DROP TABLE agent_sessions_old')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function createAgentSessionsTable(db: SQLiteDatabase, tableName: string) {
  db.exec(`
    CREATE TABLE ${tableName} (
${AGENT_SESSIONS_COLUMNS_SQL}
    );
  `)
}

function migrateLastUserMessageColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_user_message')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_user_message TEXT')
}

function migrateIsPinnedColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('is_pinned')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0')
}

function migrateLastResumeErrorColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_resume_error')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_resume_error TEXT')
}

function migrateLastKnownLogSizeColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('last_known_log_size')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN last_known_log_size INTEGER')
}

function migrateIsCodexExecColumn(db: SQLiteDatabase) {
  const columns = getColumnNames(db, 'agent_sessions')
  if (columns.length === 0 || columns.includes('is_codex_exec')) {
    return
  }
  db.exec('ALTER TABLE agent_sessions ADD COLUMN is_codex_exec INTEGER NOT NULL DEFAULT 0')
}

function migrateDeduplicateDisplayNames(db: SQLiteDatabase) {
  // Find all display names that have duplicates
  const duplicates = db
    .prepare(
      `SELECT display_name, COUNT(*) as count
       FROM agent_sessions
       GROUP BY display_name
       HAVING count > 1`
    )
    .all() as Array<{ display_name: string; count: number }>

  if (duplicates.length === 0) {
    return
  }

  const updateStmt = db.prepare(
    'UPDATE agent_sessions SET display_name = $newName WHERE session_id = $sessionId'
  )

  for (const { display_name } of duplicates) {
    // Get all sessions with this name, ordered by created_at (oldest first)
    const sessions = db
      .prepare(
        `SELECT session_id, display_name
         FROM agent_sessions
         WHERE display_name = $displayName
         ORDER BY created_at ASC`
      )
      .all({ $displayName: display_name }) as Array<{
      session_id: string
      display_name: string
    }>

    // Keep first one as-is, rename the rest
    for (let i = 1; i < sessions.length; i++) {
      const suffix = i + 1
      let newName = `${display_name}-${suffix}`

      // Make sure the new name doesn't already exist
      while (
        db
          .prepare(
            'SELECT 1 FROM agent_sessions WHERE display_name = $name LIMIT 1'
          )
          .get({ $name: newName }) != null
      ) {
        newName = `${display_name}-${suffix}-${Date.now().toString(36).slice(-4)}`
      }

      updateStmt.run({ $newName: newName, $sessionId: sessions[i].session_id })
    }
  }
}

/**
 * Migrate agent_type CHECK constraint to include 'pi'.
 * SQLite doesn't support modifying constraints, so we recreate the table.
 */
function migratePiAgentType(db: SQLiteDatabase) {
  // Check if table exists and if constraint already includes 'pi'
  const tableInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_sessions'")
    .get() as { sql: string } | undefined

  if (!tableInfo?.sql) {
    return // Table doesn't exist yet, will be created with correct constraint
  }

  // If 'pi' is already in the constraint, no migration needed
  if (tableInfo.sql.includes("'pi'")) {
    return
  }

  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE agent_sessions RENAME TO agent_sessions_old_pi_migrate')
    createAgentSessionsTable(db, 'agent_sessions')
    db.exec(`
      INSERT INTO agent_sessions (
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_pinned,
        last_resume_error,
        last_known_log_size,
        is_codex_exec
      )
      SELECT
        id,
        session_id,
        log_file_path,
        project_path,
        agent_type,
        display_name,
        created_at,
        last_activity_at,
        last_user_message,
        current_window,
        is_pinned,
        last_resume_error,
        last_known_log_size,
        is_codex_exec
      FROM agent_sessions_old_pi_migrate
    `)
    db.exec('DROP TABLE agent_sessions_old_pi_migrate')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function getColumnNames(db: SQLiteDatabase, tableName: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>
  return rows.map((row) => String(row.name ?? '')).filter(Boolean)
}
