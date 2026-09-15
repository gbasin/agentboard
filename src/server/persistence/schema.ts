/** Additive catalog schema. Provider conversations remain in agent_sessions. */
import type { Database } from 'bun:sqlite'

export function createCatalogSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS board_sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, project_path TEXT NOT NULL,
      host_id TEXT NOT NULL, agent_type TEXT, provider_id TEXT,
      command TEXT NOT NULL, state TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, current_window TEXT, epoch TEXT,
      error TEXT, preview TEXT, origin TEXT NOT NULL, last_run_id TEXT, requested_state TEXT, terminal_preview TEXT
    );
    CREATE INDEX IF NOT EXISTS board_history ON board_sessions(last_activity_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS board_provider ON board_sessions(provider_id);
    CREATE UNIQUE INDEX IF NOT EXISTS board_window ON board_sessions(host_id, epoch, current_window)
      WHERE current_window IS NOT NULL;
    CREATE TABLE IF NOT EXISTS session_runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, operation_id TEXT UNIQUE NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT, state TEXT NOT NULL,
      epoch TEXT, current_window TEXT, provider_id TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_session ON session_runs(session_id, started_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_run ON session_runs(session_id)
      WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      kind TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session ON session_events(session_id, id DESC);
    CREATE TABLE IF NOT EXISTS saved_workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, session_ids TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_index_queue (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime REAL NOT NULL,
      pending INTEGER NOT NULL DEFAULT 1, error TEXT, retry_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_archives (
      provider_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, archive_path TEXT NOT NULL,
      bytes INTEGER NOT NULL, source_size INTEGER NOT NULL, updated_at TEXT NOT NULL,
      checksum TEXT NOT NULL, complete INTEGER NOT NULL
    );
  `)
  const columns=db.query('PRAGMA table_info(board_sessions)').all() as {name:string}[]
  if(!columns.some(c=>c.name==='requested_state'))db.exec('ALTER TABLE board_sessions ADD COLUMN requested_state TEXT')
  if(!columns.some(c=>c.name==='terminal_preview'))db.exec('ALTER TABLE board_sessions ADD COLUMN terminal_preview TEXT')
}
