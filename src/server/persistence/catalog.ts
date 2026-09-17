/** Transactional session identities, launch intents, lifecycle history and workspaces. */
import { randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import type {
  SavedSession,
  Lifecycle,
  SessionEvent,
  SavedWorkspace,
  HistoryQuery,
} from '../../shared/persistence'
import { createCatalogSchema } from './schema'
import { queryHistory, readSession, sessionSelect } from './historyQuery'

export class SessionCatalog {
  constructor(
    readonly db: Database,
    readonly hostId: string
  ) {
    createCatalogSchema(db)
  }
  get(id: string) {
    return readSession(this.db.query(`${sessionSelect} WHERE id=?`).get(id))
  }
  byWindow(window: string, epoch?: string) {
    return readSession(
      this.db
        .query(
          `${sessionSelect} WHERE host_id=? AND current_window=? ${epoch ? 'AND epoch=?' : ''}`
        )
        .get(...(epoch ? [this.hostId, window, epoch] : [this.hostId, window]))
    )
  }
  byProvider(id: string) {
    return readSession(
      this.db
        .query(
          `${sessionSelect} WHERE provider_id=? OR EXISTS
    (SELECT 1 FROM session_conversations c WHERE c.session_id=board_sessions.id AND c.provider_id=?) ORDER BY last_activity_at DESC LIMIT 1`
        )
        .get(id, id)
    )
  }
  history(query: HistoryQuery = {}) {
    return queryHistory(this.db, query)
  }
  active() {
    return this.db
      .query(
        `${sessionSelect} WHERE host_id=? AND state IN ('running','starting')`
      )
      .all(this.hostId)
      .map((r) => readSession(r)!)
  }
  event(id: string, kind: string, detail: string | null = null) {
    const now = new Date().toISOString()
    this.db
      .query(
        'INSERT INTO session_events(session_id,kind,detail,created_at) VALUES(?,?,?,?)'
      )
      .run(id, kind, detail, now)
    this.db
      .query(
        "INSERT OR REPLACE INTO app_settings(key,value) VALUES('persistence_last_saved',?)"
      )
      .run(now)
  }
  events(id: string): SessionEvent[] {
    return this.db
      .query(
        'SELECT id,session_id AS sessionId,kind,detail,created_at AS createdAt FROM session_events WHERE session_id=? ORDER BY id DESC LIMIT 100'
      )
      .all(id) as SessionEvent[]
  }
  create(
    input: Pick<SavedSession, 'name' | 'projectPath' | 'command'> &
      Partial<SavedSession>
  ) {
    const now = new Date().toISOString(),
      id = input.id || randomUUID()
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO board_sessions(id,name,project_path,host_id,agent_type,provider_id,command,state,pinned,created_at,last_activity_at,current_window,epoch,error,preview,origin,last_run_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          input.name,
          input.projectPath,
          this.hostId,
          input.agentType ?? null,
          input.providerId ?? null,
          input.command,
          input.state || 'interrupted',
          Number(input.pinned || false),
          input.createdAt || now,
          input.lastActivityAt || now,
          input.window ?? null,
          input.epoch ?? null,
          null,
          input.preview ?? null,
          input.origin || 'managed',
          null
        )
      this.event(
        id,
        input.origin === 'imported' ? 'imported' : 'created',
        input.name
      )
      if (input.providerId)
        this.db
          .query('INSERT OR IGNORE INTO session_conversations VALUES(?,?,?)')
          .run(id, input.providerId, now)
    })()
    return this.get(id)!
  }
  beginRun(id: string, operationId: string = randomUUID()) {
    return this.db
      .transaction(() => {
        const previous = this.db
          .query(
            'SELECT id,session_id AS sessionId,state FROM session_runs WHERE operation_id=?'
          )
          .get(operationId) as {
          id: string
          sessionId: string
          state: string
        } | null
        if (previous) {
          if (previous.sessionId !== id)
            throw new Error('Operation belongs to another session')
          return { id: previous.id, reused: true }
        }
        const session = this.get(id)
        if (!session) throw new Error('Session not found')
        if (session.state === 'running' || session.state === 'starting')
          throw new Error('Session is already running or starting')
        const runId = randomUUID(),
          now = new Date().toISOString()
        this.db
          .query(
            `INSERT INTO session_runs(id,session_id,operation_id,started_at,state,provider_id) VALUES(?,?,?,?,'starting',?)`
          )
          .run(runId, id, operationId, now, session.providerId)
        this.db
          .query(
            "UPDATE board_sessions SET state='starting',last_run_id=?,error=NULL WHERE id=?"
          )
          .run(runId, id)
        this.event(id, 'starting')
        return { id: runId, reused: false }
      })
      .immediate()
  }
  byOperation(operationId: string) {
    const run = this.db
      .query('SELECT session_id AS id FROM session_runs WHERE operation_id=?')
      .get(operationId) as { id: string } | null
    return run ? this.get(run.id) : null
  }
  bind(
    id: string,
    runId: string,
    window: string,
    epoch: string,
    name?: string
  ) {
    this.db.transaction(() => {
      const run = this.db
        .query('SELECT session_id,ended_at FROM session_runs WHERE id=?')
        .get(runId) as { session_id: string; ended_at: string | null } | null
      if (!run || run.session_id !== id || run.ended_at)
        throw new Error('Launch attempt is no longer current')
      this.db
        .query(
          "UPDATE board_sessions SET state='running',current_window=?,epoch=?,error=NULL,name=COALESCE(?,name),last_run_id=? WHERE id=?"
        )
        .run(window, epoch, name ?? null, runId, id)
      this.db
        .query(
          "UPDATE session_runs SET state='running',current_window=?,epoch=? WHERE id=?"
        )
        .run(window, epoch, runId)
      this.event(id, 'running', window)
    })()
  }
  transition(id: string, state: Lifecycle, error: string | null = null) {
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('Session not found')
      this.db
        .query(
          'UPDATE board_sessions SET state=?,current_window=NULL,requested_state=NULL,error=? WHERE id=?'
        )
        .run(state, error, id)
      this.db
        .query(
          'UPDATE session_runs SET state=?,ended_at=?,error=? WHERE session_id=? AND ended_at IS NULL'
        )
        .run(state, new Date().toISOString(), error, id)
      this.event(id, state, error)
    })()
  }
  rename(id: string, name: string) {
    const value = name.trim()
    if (!/^[\w-]{1,120}$/.test(value))
      throw new Error(
        'Name must use 1–120 letters, numbers, hyphens or underscores'
      )
    this.db.transaction(() => {
      const current = this.get(id)
      if (!current) throw new Error('Session not found')
      this.db
        .query('UPDATE board_sessions SET name=? WHERE id=?')
        .run(value, id)
      this.event(id, 'renamed', `${current.name} → ${value}`)
    })()
  }
  pin(id: string, pinned: boolean) {
    if (!this.get(id)) throw new Error('Session not found')
    this.db.transaction(() => {
      this.db
        .query('UPDATE board_sessions SET pinned=? WHERE id=?')
        .run(Number(pinned), id)
      this.event(id, pinned ? 'pinned' : 'unpinned')
    })()
  }
  associate(
    id: string,
    providerId: string,
    agentType: string,
    preview?: string | null
  ) {
    const current = this.get(id)
    if (!current) throw new Error('Session not found')
    if (
      current.providerId === providerId &&
      current.agentType === agentType &&
      (!preview || current.preview === preview.slice(0, 8192))
    )
      return
    this.db.transaction(() => {
      // Independent discovery can import a conversation before its live pane is
      // matched. Fold only that unlaunched import into the managed identity.
      // Two independently launched sessions must remain separate for review.
      const imported = this.byProvider(providerId)
      if (
        imported &&
        imported.id !== id &&
        imported.origin === 'imported' &&
        !imported.lastRunId
      ) {
        this.db
          .query('UPDATE session_events SET session_id=? WHERE session_id=?')
          .run(id, imported.id)
        for (const workspace of this.workspaces()) {
          if (!workspace.sessionIds.includes(imported.id)) continue
          const ids = [
            ...new Set(
              workspace.sessionIds.map((value) =>
                value === imported.id ? id : value
              )
            ),
          ]
          this.db
            .query('UPDATE saved_workspaces SET session_ids=? WHERE id=?')
            .run(JSON.stringify(ids), workspace.id)
        }
        this.db
          .query(
            'UPDATE board_sessions SET pinned=MAX(pinned,?),created_at=MIN(created_at,?),last_activity_at=MAX(last_activity_at,?) WHERE id=?'
          )
          .run(
            Number(imported.pinned),
            imported.createdAt,
            imported.lastActivityAt,
            id
          )
        this.event(id, 'conversation-linked', imported.name)
        this.db
          .query(
            'INSERT OR IGNORE INTO session_conversations SELECT ?,provider_id,linked_at FROM session_conversations WHERE session_id=?'
          )
          .run(id, imported.id)
        this.db
          .query('DELETE FROM session_conversations WHERE session_id=?')
          .run(imported.id)
        this.db.query('DELETE FROM board_sessions WHERE id=?').run(imported.id)
      }
      this.db
        .query('INSERT OR IGNORE INTO session_conversations VALUES(?,?,?)')
        .run(id, providerId, new Date().toISOString())
      this.db
        .query(
          'UPDATE board_sessions SET provider_id=?,agent_type=?,preview=COALESCE(?,preview) WHERE id=?'
        )
        .run(providerId, agentType, preview?.slice(0, 8192) ?? null, id)
      this.db
        .query(
          'UPDATE session_runs SET provider_id=? WHERE session_id=? AND ended_at IS NULL'
        )
        .run(providerId, id)
    })()
  }
  updateActivity(id: string, time: string, preview?: string) {
    const current = this.get(id)
    if (
      !current ||
      (time <= current.lastActivityAt &&
        (!preview || current.preview === preview.slice(0, 8192)))
    )
      return
    this.db
      .query(
        'UPDATE board_sessions SET last_activity_at=MAX(last_activity_at,?),preview=COALESCE(?,preview) WHERE id=?'
      )
      .run(time, preview?.slice(0, 8192) ?? null, id)
  }
  workspaces(): SavedWorkspace[] {
    return (
      this.db
        .query(
          'SELECT id,name,session_ids AS sessionIds,created_at AS createdAt FROM saved_workspaces ORDER BY created_at DESC'
        )
        .all() as Array<
        Omit<SavedWorkspace, 'sessionIds'> & { sessionIds: string }
      >
    ).map((w) => ({ ...w, sessionIds: JSON.parse(w.sessionIds) }))
  }
  saveWorkspace(name: string, ids: string[]) {
    if (!name.trim() || name.length > 120 || !ids.length || ids.length > 100)
      throw new Error('Choose a name and 1–100 sessions')
    const sessionIds = [...new Set(ids)]
    if (sessionIds.some((id) => !this.get(id)))
      throw new Error('Workspace contains a missing session')
    const workspace = {
      id: randomUUID(),
      name: name.trim(),
      sessionIds,
      createdAt: new Date().toISOString(),
    }
    this.db
      .query('INSERT INTO saved_workspaces VALUES(?,?,?,?)')
      .run(
        workspace.id,
        workspace.name,
        JSON.stringify(sessionIds),
        workspace.createdAt
      )
    return workspace
  }
  deleteWorkspace(id: string) {
    this.db.query('DELETE FROM saved_workspaces WHERE id=?').run(id)
  }
}
