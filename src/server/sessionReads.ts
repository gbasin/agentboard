/** Indexed reads shared by the main connection and the read-only worker. */
import type { Database } from 'bun:sqlite'
import type { KnownSessionKey, SessionDatabase } from './db'
import { mapRow } from './sessionRecord'

export type SessionLists = ReturnType<SessionDatabase['getSessionLists']>
export interface SnapshotOptions {
  maxAgeHours?: number
  /** Omit to read all keys; [] skips keys (orphan rematching). */
  paths?: string[]
}
export interface PollSnapshot {
  lists: SessionLists
  knownSessions: KnownSessionKey[]
}
export interface SessionReader {
  snapshot(options: SnapshotOptions): Promise<PollSnapshot>
  importCandidates(): Promise<string[]>
}

// Disjoint branches let SQLite seek active, hibernating and recent history
// independently. The previous OR predicate scanned every old history row.
// Use a separate unbounded statement rather than a nullable cutoff OR, which
// prevents the history branch from using the timestamp range of the index.
export function sessionListsSql(bounded: boolean): string {
  return `SELECT * FROM (
    SELECT * FROM agent_sessions WHERE current_window IS NOT NULL
    UNION ALL
    SELECT * FROM agent_sessions WHERE current_window IS NULL AND is_hibernating=1
    UNION ALL
    SELECT * FROM agent_sessions WHERE current_window IS NULL AND is_hibernating=0
      ${bounded ? 'AND last_activity_at > $cutoff' : ''}
  ) ORDER BY (current_window IS NULL),
    CASE WHEN current_window IS NULL THEN last_activity_at END DESC, session_id`
}

export function readSessionLists(db: Database, options?: { maxAgeHours?: number }): SessionLists {
  const cutoff = options?.maxAgeHours
    ? new Date(Date.now() - options.maxAgeHours * 3600000).toISOString()
    : null
  const query = db.query(sessionListsSql(cutoff !== null))
  const rows = (cutoff === null ? query.all() : query.all({ $cutoff: cutoff })) as Record<string, unknown>[]
  const lists: SessionLists = { active: [], hibernating: [], history: [] }
  for (const row of rows) {
    const record = mapRow(row)
    if (record.currentWindow !== null) lists.active.push(record)
    else if (record.isHibernating) lists.hibernating.push(record)
    else lists.history.push(record)
  }
  return lists
}

const KEY_COLUMNS = `session_id AS sessionId, log_file_path AS logFilePath,
  project_path AS projectPath, slug, agent_type AS agentType, is_codex_exec AS isCodexExec`

export function readPollSnapshot(db: Database, options: SnapshotOptions): PollSnapshot {
  // End the read transaction before posting a response: never pin the WAL
  // while matching logs, waiting on the main thread, or sitting idle.
  return db.transaction(() => {
    const lists = readSessionLists(db, options)
    const rows = options.paths === undefined
      ? db.query(`SELECT ${KEY_COLUMNS} FROM agent_sessions`).all()
      : options.paths.flatMap((logPath) => {
          const row = db.query(`SELECT ${KEY_COLUMNS} FROM agent_sessions WHERE log_file_path=?`).get(logPath)
          return row ? [row] : []
        })
    const knownSessions = (rows as KnownSessionKey[]).map((row) => ({
      ...row, isCodexExec: Boolean(row.isCodexExec),
    }))
    return { lists, knownSessions }
  })()
}

export const IMPORT_CANDIDATES_SQL = `SELECT session_id AS id FROM agent_sessions a
  WHERE a.is_codex_exec=0 AND NOT EXISTS
  (SELECT 1 FROM session_conversations c WHERE c.provider_id=a.session_id)
  ORDER BY id LIMIT 100`

export function readImportCandidates(db: Database): string[] {
  return (db.query(IMPORT_CANDIDATES_SQL).all() as { id: string }[]).map((row) => row.id)
}
