// devinSyncFixture.ts - Temp Devin CLI sessions.db builder shared by the
// devinSync test files. Each test gets a fresh temp root with DEVIN_CLI_DIR
// pointed at it; call useDevinSyncFixture() at module top level.
import { afterEach, beforeEach } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Database as SQLiteDatabase } from 'bun:sqlite'

export const paths = { tempRoot: '', cliDir: '', outDir: '', dbPath: '' }

export function useDevinSyncFixture(): void {
  const originalDevinCliDir = process.env.DEVIN_CLI_DIR
  beforeEach(async () => {
    paths.tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentboard-devin-'))
    paths.cliDir = path.join(paths.tempRoot, 'devin-cli')
    paths.outDir = path.join(paths.tempRoot, 'devin-sessions')
    paths.dbPath = path.join(paths.cliDir, 'sessions.db')
    process.env.DEVIN_CLI_DIR = paths.cliDir
  })
  afterEach(async () => {
    if (originalDevinCliDir) process.env.DEVIN_CLI_DIR = originalDevinCliDir
    else delete process.env.DEVIN_CLI_DIR
    await fsp.rm(paths.tempRoot, { recursive: true, force: true })
  })
}

// Mirrors the real schema (verified against Devin CLI's sessions.db),
// trimmed to the columns and indexes the sync reads.
export function createDevinDb(): SQLiteDatabase {
  fs.mkdirSync(paths.cliDir, { recursive: true })
  const db = new SQLiteDatabase(paths.dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL,
      model TEXT NOT NULL,
      agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      title TEXT,
      hidden INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message_nodes (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL,
      parent_node_id INTEGER,
      chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_message_nodes_session ON message_nodes(session_id);
  `)
  return db
}

export function openDb(): SQLiteDatabase {
  return new SQLiteDatabase(paths.dbPath)
}

export function addSession(
  db: SQLiteDatabase,
  id: string,
  cwd: string,
  title: string | null,
  hidden = 0
): void {
  db.prepare(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, hidden)
     VALUES ($id, $cwd, 'local', 'm', 'normal', 1700000000, 1700000100, $title, $hidden)`
  ).run({ $id: id, $cwd: cwd, $title: title, $hidden: hidden })
}

export function addMessage(
  db: SQLiteDatabase,
  sessionId: string,
  role: string,
  content: string,
  createdAt = 1700000050
): void {
  db.prepare(
    `INSERT INTO message_nodes (session_id, node_id, chat_message, created_at)
     VALUES ($sessionId, 0, $chat, $createdAt)`
  ).run({
    $sessionId: sessionId,
    $chat: JSON.stringify({ role, content }),
    $createdAt: createdAt,
  })
}

export function readLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * Identity of a file's current contents: inode + size + mtime. Atomic
 * rewrites (tmp + rename) always change the inode, so "unchanged" asserts
 * cannot pass falsely on filesystems with coarse (per-tick) mtime.
 */
export function fileId(file: string): string {
  const stat = fs.statSync(file, { bigint: true })
  return `${stat.ino}:${stat.size}:${stat.mtimeNs}`
}

export function inode(file: string): bigint {
  return fs.statSync(file, { bigint: true }).ino
}
