// devinSync.ts - Mirrors Devin CLI sessions into synthesized JSONL logs
//
// Devin CLI stores sessions in SQLite at ~/.local/share/devin/cli/sessions.db
// rather than per-session JSONL files like Claude/Codex/Pi. To reuse the
// existing log pipeline (discovery, window matching, lastUserMessage,
// activity timestamps), we mirror each session's message_nodes rows into
// ~/.agentboard/devin-sessions/<session-id>.jsonl in a Claude-compatible
// shape: {"type","agent":"devin","sessionId","cwd","timestamp","message"}.
//
// Sync state (last synced row_id + message count per session) is persisted in
// .sync-state.json next to the logs so restarts don't rewrite every file.
// Files are append-only when the session's message list grows; a shrunk or
// reordered message list (revert/compaction) triggers a full atomic rewrite.

import fs from 'node:fs'
import path from 'node:path'
import { Database as SQLiteDatabase } from 'bun:sqlite'
import { logger } from './logger'

const SYNC_STATE_FILE = '.sync-state.json'
const KEPT_ROLES = new Set(['user', 'assistant', 'system', 'tool'])

// Bump when the mirrored line format changes; forces a one-time full
// rewrite so existing mirrors gain the new fields.
const MIRROR_FORMAT_VERSION = 3

export function getDevinCliDir(): string {
  const override = process.env.DEVIN_CLI_DIR
  if (override && override.trim()) {
    return override.trim()
  }
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(home, '.local', 'share')
  return path.join(dataHome, 'devin', 'cli')
}

export function getDevinSessionsDbPath(): string {
  return path.join(getDevinCliDir(), 'sessions.db')
}

export function getDevinSessionLocksDir(): string {
  return path.join(getDevinCliDir(), 'session_locks')
}

export function getDevinLogOutDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dataDir = process.env.AGENTBOARD_DATA_DIR?.trim() || path.join(home, '.agentboard')
  return path.join(dataDir, 'devin-sessions')
}

interface DevinSessionRow {
  id: string
  working_directory: string
  title: string | null
  created_at: number
  last_activity_at: number
}

interface DevinMessageRow {
  row_id: number
  chat_message: string
  created_at: number
}

interface DevinSessionSyncState {
  /** row_id of the last synced message_nodes row */
  lastRowId: number
  /** number of message_nodes rows synced (all roles, including filtered ones) */
  rowCount: number
}

interface SyncState {
  formatVersion?: number
  sessions: Record<string, DevinSessionSyncState>
}

function unixSecondsToIso(value: number): string {
  const ms = Number.isFinite(value) ? value * 1000 : 0
  return new Date(ms).toISOString()
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function sanitizeFileName(sessionId: string): string {
  // Devin session ids are slugs (e.g. "flawless-bobolink"), but be defensive.
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_')
  return cleaned || 'session'
}

function metaLine(session: DevinSessionRow): string {
  const label = session.title?.trim() || session.id
  return JSON.stringify({
    type: 'system',
    agent: 'devin',
    sessionId: session.id,
    cwd: session.working_directory,
    timestamp: unixSecondsToIso(session.created_at),
    message: {
      role: 'system',
      content: `Devin session ${label}`,
    },
  })
}

function messageToLine(
  session: DevinSessionRow,
  row: DevinMessageRow
): string | null {
  const chat = safeParseJson(row.chat_message)
  if (!chat) return null
  const role = typeof chat.role === 'string' ? chat.role : ''
  if (!KEPT_ROLES.has(role)) return null

  // Devin writes internal 'user' rows (cache keepalive "continue" prompts,
  // compaction summarization requests) flagged with is_user_input: null.
  // Keep only genuine user input so lastUserMessage/matching see real prompts.
  if (role === 'user') {
    const metadata = chat.metadata as Record<string, unknown> | undefined
    if (metadata && metadata.is_user_input !== true) return null
  }

  const content = chat.content
  const toolCalls = Array.isArray(chat.tool_calls)
    ? chat.tool_calls
        .filter(
          (call): call is Record<string, unknown> =>
            typeof call === 'object' && call !== null
        )
        .map((call) => ({
          id: typeof call.id === 'string' ? call.id : '',
          name:
            typeof call.name === 'string'
              ? call.name
              : typeof (call.function as Record<string, unknown> | undefined)?.name === 'string'
                ? (call.function as Record<string, unknown>).name
                : '',
          arguments: call.arguments ?? (call.function as Record<string, unknown> | undefined)?.arguments ?? null,
        }))
        .filter((call) => call.id || call.name)
    : []
  const hasContent =
    typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content)
        ? content.length > 0
        : Boolean(content)
  if (!hasContent && toolCalls.length === 0) return null

  const message: Record<string, unknown> = { role, content: content ?? '' }
  if (toolCalls.length > 0) message.toolCalls = toolCalls
  if (role === 'tool' && typeof chat.tool_call_id === 'string') {
    message.toolCallId = chat.tool_call_id
  }

  return JSON.stringify({
    type: role,
    agent: 'devin',
    sessionId: session.id,
    cwd: session.working_directory,
    timestamp: unixSecondsToIso(row.created_at),
    message,
  })
}

function loadSyncState(outDir: string): SyncState {
  try {
    const raw = fs.readFileSync(path.join(outDir, SYNC_STATE_FILE), 'utf8')
    const parsed = safeParseJson(raw)
    if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) {
      return parsed as unknown as SyncState
    }
  } catch {
    // Missing or corrupt state - start fresh
  }
  return { sessions: {} }
}

function writeJsonAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tmpPath, data)
  fs.renameSync(tmpPath, filePath)
}

export interface DevinSyncResult {
  sessions: number
  rewritten: number
  appended: number
  removed: number
}

/**
 * Mirror devin sessions.db into synthesized JSONL logs.
 * No-op when the devin CLI data directory doesn't exist.
 */
export function syncDevinSessions(outDir = getDevinLogOutDir()): DevinSyncResult | null {
  const dbPath = getDevinSessionsDbPath()
  if (!fs.existsSync(dbPath)) {
    return null
  }

  let db: SQLiteDatabase | null = null
  try {
    db = new SQLiteDatabase(dbPath, { readonly: true })
  } catch (error) {
    logger.warn('devin_sync_open_failed', {
      dbPath,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  const result: DevinSyncResult = { sessions: 0, rewritten: 0, appended: 0, removed: 0 }
  try {
    const sessions = db
      .prepare(
        `SELECT id, working_directory, title, created_at, last_activity_at
         FROM sessions WHERE hidden = 0`
      )
      .all() as DevinSessionRow[]
    result.sessions = sessions.length

    fs.mkdirSync(outDir, { recursive: true })
    const state = loadSyncState(outDir)
    if (state.formatVersion !== MIRROR_FORMAT_VERSION) {
      state.sessions = {}
    }
    const nextState: SyncState = {
      formatVersion: MIRROR_FORMAT_VERSION,
      sessions: {},
    }

    const rowsStmt = db.prepare(
      `SELECT row_id, chat_message, created_at FROM message_nodes
       WHERE session_id = $sessionId ORDER BY row_id ASC`
    )
    const boundaryStmt = db.prepare(
      `SELECT row_id FROM message_nodes
       WHERE session_id = $sessionId ORDER BY row_id ASC LIMIT 1 OFFSET $offset`
    )

    for (const session of sessions) {
      const fileName = `${sanitizeFileName(session.id)}.jsonl`
      const filePath = path.join(outDir, fileName)
      const prior = state.sessions[session.id]

      // Fast path: append when the synced prefix is unchanged.
      // Verify integrity via the boundary row: the row at offset=rowCount-1
      // must have row_id === prior.lastRowId.
      let appended = false
      if (prior && prior.rowCount > 0 && fs.existsSync(filePath)) {
        const boundary = boundaryStmt.get({
          $sessionId: session.id,
          $offset: prior.rowCount - 1,
        }) as { row_id: number } | null
        if (boundary && boundary.row_id === prior.lastRowId) {
          const newRows = (
            rowsStmt.all({ $sessionId: session.id }) as DevinMessageRow[]
          ).filter((row) => row.row_id > prior.lastRowId)
          const newLines = newRows
            .map((row) => messageToLine(session, row))
            .filter((line): line is string => line !== null)
          if (newLines.length > 0) {
            fs.appendFileSync(filePath, newLines.join('\n') + '\n')
            result.appended += 1
          }
          const lastRowId =
            newRows.length > 0 ? newRows[newRows.length - 1].row_id : prior.lastRowId
          nextState.sessions[session.id] = {
            lastRowId,
            rowCount: prior.rowCount + newRows.length,
          }
          appended = true
        }
      }

      if (!appended) {
        const rows = rowsStmt.all({ $sessionId: session.id }) as DevinMessageRow[]
        const lines = [metaLine(session)]
        let lastRowId = 0
        for (const row of rows) {
          const line = messageToLine(session, row)
          if (line !== null) lines.push(line)
          lastRowId = row.row_id
        }
        writeJsonAtomic(filePath, lines.join('\n') + '\n')
        nextState.sessions[session.id] = { lastRowId, rowCount: rows.length }
        result.rewritten += 1
      }
    }

    // Remove JSONL files for sessions that are gone or hidden.
    for (const entry of fs.readdirSync(outDir)) {
      if (!entry.endsWith('.jsonl')) continue
      const id = entry.slice(0, -'.jsonl'.length)
      const stillLive = sessions.some(
        (session) => sanitizeFileName(session.id) === id
      )
      if (!stillLive) {
        try {
          fs.unlinkSync(path.join(outDir, entry))
          result.removed += 1
        } catch {
          // ignore
        }
      }
    }

    writeJsonAtomic(path.join(outDir, SYNC_STATE_FILE), JSON.stringify(nextState))
    return result
  } catch (error) {
    logger.warn('devin_sync_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  } finally {
    db.close()
  }
}
