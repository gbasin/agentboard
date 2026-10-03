/** Bounded, cursor-based catalog queries. Old titles participate in search. */
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import type {
  HistoryPage,
  HistoryQuery,
  SavedSession,
} from '../../shared/persistence'

export const sessionSelect = `SELECT id, name, project_path AS projectPath, host_id AS hostId,
 agent_type AS agentType, provider_id AS providerId, command, state, pinned,
 created_at AS createdAt, last_activity_at AS lastActivityAt, current_window AS window,
 epoch, error, preview, origin, last_run_id AS lastRunId, requested_state AS requestedState FROM board_sessions`
export function readSession(row: unknown): SavedSession | null {
  if (!row) return null
  const session = row as SavedSession
  return { ...session, pinned: Boolean(session.pinned) }
}
export function queryHistory(
  db: Database,
  query: HistoryQuery = {}
): HistoryPage {
  const where: string[] = []
  const values: SQLQueryBindings[] = []
  const add = (sql: string, value?: SQLQueryBindings) => {
    where.push(sql)
    if (value !== undefined) values.push(value)
  }
  if (query.q?.trim()) {
    const pattern = `%${query.q.trim().replace(/[\\%_]/g, '\\$&')}%`
    add(`(name LIKE ? ESCAPE '\\' OR project_path LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=board_sessions.id AND e.kind='renamed' AND e.detail LIKE ? ESCAPE '\\'))`)
    values.push(pattern, pattern, pattern, pattern)
  }
  if (query.state === 'previously-open')
    add(
      "origin != 'imported' OR EXISTS (SELECT 1 FROM session_runs r WHERE r.session_id=board_sessions.id)"
    )
  else if (query.state && query.state !== 'all') add('state=?', query.state)
  if (query.project) add('project_path=?', query.project)
  if (query.agent) add('agent_type=?', query.agent)
  if (query.pinned) add('pinned=1')
  if (query.hours && query.hours > 0)
    add(
      'last_activity_at>=?',
      new Date(Date.now() - query.hours * 3600000).toISOString()
    )
  if (query.cursor) {
    try {
      const cursor = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString()
      )
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 2 ||
        cursor.some((x) => typeof x !== 'string')
      )
        throw Error()
      add('(last_activity_at < ? OR (last_activity_at = ? AND id < ?))')
      values.push(cursor[0], cursor[0], cursor[1])
    } catch {
      throw new Error('Invalid history cursor')
    }
  }
  const limit = Math.min(100, Math.max(1, Math.floor(query.limit || 50)))
  const rows = db
    .query(
      `${sessionSelect} ${where.length ? `WHERE ${where.map((w) => `(${w})`).join(' AND ')}` : ''}
    ORDER BY last_activity_at DESC, id DESC LIMIT ?`
    )
    .all(...values, limit + 1)
    .map((r) => readSession(r)!)
  const sessions = rows.slice(0, limit)
  const last = sessions.at(-1)
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.lastActivityAt, last.id])).toString(
          'base64url'
        )
      : null
  return { sessions, nextCursor }
}
