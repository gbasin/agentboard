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
  getInactiveSessions: () => AgentSessionRecord[]
  orphanSession: (sessionId: string) => AgentSessionRecord | null
  displayNameExists: (displayName: string, excludeSessionId?: string) => boolean
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
  agent_type TEXT NOT NULL CHECK (agent_type IN ('claude', 'codex')),
  display_name TEXT,
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_user_message TEXT,
  current_window TEXT
`

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_sessions (
${AGENT_SESSIONS_COLUMNS_SQL}
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
  migrateLastUserMessageColumn(db)
  migrateDeduplicateDisplayNames(db)

  const insertStmt = db.prepare(
    `INSERT INTO agent_sessions
      (session_id, log_file_path, project_path, agent_type, display_name, created_at, last_activity_at, last_user_message, current_window)
     VALUES ($sessionId, $logFilePath, $projectPath, $agentType, $displayName, $createdAt, $lastActivityAt, $lastUserMessage, $currentWindow)`
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
      }

      const fields: string[] = []
      const params: Record<string, string | number | null> = {
        $sessionId: sessionId,
      }
      for (const [key, value] of entries) {
        const field = fieldMap[key]
        if (!field) continue
        fields.push(field)
        params[`$${field}`] = value as string | number | null
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
    getInactiveSessions: () => {
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

function getColumnNames(db: SQLiteDatabase, tableName: string): string[] {
  const rows = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>
  return rows.map((row) => String(row.name ?? '')).filter(Boolean)
}
