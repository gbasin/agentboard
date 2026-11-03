// Durable team tasks (team-tasks design D1): the record, its numbered
// immutable revisions of direction/acceptance, and an append-only journal,
// all in the server's SQLite database beside `team_messages` and
// `chat_sessions`. Tasks outlive every session that touched them — nothing
// here deletes a row. Participants are derived, never stored: the creator,
// sessions associated with the task, senders/claimants of task mail, and
// journal authors. The store is policy-free; who may do what is decided by
// TaskService before it calls in.
import type { Database } from 'bun:sqlite'
import type {
  JournalAuthor,
  TaskActor,
  TaskCreator,
  TaskJournalEntry,
  TaskRevision,
  TaskStatus,
  HumanTaskDetail,
  TeamTask,
  TeamTaskAssignment,
  TeamTaskDetail,
  TeamTaskSummary,
} from '../../shared/teamTasks'
import { partyFromRow } from './actorRow'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { outstandingOf, type AssignmentStore } from './assignmentStore'
import { rawCoverage } from '../../shared/coverageMaps'
import type { MailboxStore } from './mailboxStore'
import { migrateRevisionSchema } from './taskRevisionSchema'
import { TaskDraftStore } from './taskDrafts'
import { TaskAcknowledgements } from './taskAcknowledgements'
import { TaskNotices } from './taskNotices'
import { TaskResultStore } from './taskResultStore'
import { ResultCheckStore } from '../verification/resultCheckStore'
import { createPayloadDiff, publishPayloadDiff } from './taskPayloadDiff'
import { TaskJournalWindow } from './taskJournalWindow'
import { TaskListWindow } from './taskListWindow'

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS team_tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  creator_kind TEXT NOT NULL,
  creator_session TEXT,
  parent_id TEXT,
  worktree TEXT,
  openspec_change TEXT,
  request_key TEXT,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_tasks_team ON team_tasks (team_id, created_at);
CREATE INDEX IF NOT EXISTS team_tasks_parent ON team_tasks (parent_id);
CREATE TABLE IF NOT EXISTS team_task_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  direction TEXT NOT NULL,
  acceptance TEXT,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
CREATE TABLE IF NOT EXISTS team_task_journal (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  author_session TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS team_task_journal_task ON team_task_journal (task_id, created_at);
`

/**
 * Create the task tables and their revision schema; part of the frozen
 * baseline step (execution-safety-recovery D13): the baseline step calls this, never the store.
 */
export function ensureTaskSchema(db: Database): void {
  db.exec(CREATE_TABLES_SQL)
  migrateTable(db)
  migrateRevisionSchema(db)
}

/** Columns added after the table first shipped (task-assignment D4). */
function migrateTable(db: Database) {
  const columns = db.prepare('PRAGMA table_info(team_tasks)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'request_key')) {
    db.exec('ALTER TABLE team_tasks ADD COLUMN request_key TEXT')
  }
  // Created here, not in CREATE_TABLES_SQL: a legacy table gains the column
  // only in the ALTER above, after the DDL block has already run.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS team_tasks_request_key ON team_tasks (team_id, request_key)')
}

export interface CreateTaskInput {
  teamId: string
  title: string
  direction: string
  acceptance?: string | null
  creator: TaskCreator
  parentId?: string | null
  worktree?: string | null
  openspecChange?: string | null
  /** The plan-change link (durable-plans D9), validated by the caller; fixed at creation. */
  planId?: string | null
  planChange?: string | null
  /**
   * The client's request identity for this create (task-assignment D4): a
   * replay under the same key and payload returns the prior task instead of
   * a duplicate; the same key with a different payload is refused.
   */
  requestKey?: string | null
  /** A pre-minted id, so a fix task's direction can name it (plan-supervision D7); else minted here. */
  id?: string
}

/** One publication (task-revision-publication D2); fields are normalized by the caller. */
export interface PublishInput {
  /** Omitted fields carry over from the current revision. */
  direction?: string
  acceptance?: string | null
  rationale?: string | null
  /** The revision the draft was based on; a newer current revision refuses it as stale. */
  baseRevision?: number
  /** The client command key: a replay with the same payload returns the prior revision. */
  requestKey?: string
  notify: boolean
  /** Drop the human's draft in the same transaction (the publication came from it). */
  discardDraft?: boolean
  /** Runs inside the publication transaction after the revision row (the notices, D3). */
  within?: (revision: TaskRevision, task: TeamTask) => void
}

export interface PublishOutcome {
  /** True when the key had already published: nothing was written. */
  replay: boolean
  task: TeamTask
  revision: TaskRevision
}

const nowIso = () => new Date().toISOString()

export class TaskStore {
  private readonly listeners = new Set<(task: TeamTask) => void>()
  /** The human's drafts (task-revision-publication D1): never read by agent paths. */
  readonly drafts: TaskDraftStore
  /** Agents' acknowledged revisions (D6). */
  readonly acknowledgements: TaskAcknowledgements
  /** Revision notices and derived recipients (D3–D5); null without mail and assignments. */
  readonly notices: TaskNotices | null
  /** Submitted results and their findings (task-results-handoffs D1). */
  readonly results: TaskResultStore
  /** Result checks and coverage maps (independent-verification D4). */
  readonly checks: ResultCheckStore
  /** The agent's bounded detail and lossless entry reads (bounded-log-reads D4–D6); no tool calls them yet. */
  readonly journalWindow: TaskJournalWindow
  /** The agent's bounded, compact task list (bounded-task-list D3). */
  readonly listWindow: TaskListWindow

  constructor(private readonly db: Database, private readonly mail?: MailboxStore, private readonly assignments?: AssignmentStore) {
    // A claim or release of a task's instruction mail changes what the task
    // views show (the assignment's holder); announce the task so the plan
    // views of an owned change re-push (plan-execution D17).
    this.mail?.subscribe((_teamId, message) => {
      if (message?.taskId && (message.state === 'claimed' || message.state === 'queued')) this.changed(message.taskId)
    })
    this.drafts = new TaskDraftStore(db)
    this.acknowledgements = new TaskAcknowledgements(db)
    this.notices = mail && assignments ? new TaskNotices(db, mail, assignments, this.acknowledgements) : null
    this.results = new TaskResultStore(db)
    this.checks = new ResultCheckStore(db)
    this.journalWindow = new TaskJournalWindow(db, this, mail)
    this.listWindow = new TaskListWindow(db, this)
  }

  /** Every committed change, with the task as it is now. */
  subscribe(listener: (task: TeamTask) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string): TeamTask {
    const task = this.get(id)!
    for (const listener of this.listeners) listener(task)
    return task
  }

  /** `within` runs in the insert's transaction with the new task (plan-supervision D7's `plan_fix_tasks` row). */
  create(input: CreateTaskInput, now = nowIso(), within?: (task: TeamTask) => void): TeamTask {
    // Request identity (task-assignment D4): insert-then-read by the unique
    // key. A same-payload replay returns the prior task; a different payload
    // under the key is refused naming the differing field. Post-create
    // mutations (status, later revisions) are never payload differences.
    if (input.requestKey) {
      const existing = this.byRequestKey(input.teamId, input.requestKey)
      if (existing) {
        const diff = createPayloadDiff(existing, this.revisions(existing.id)[0], input)
        if (diff) throw new Error(`Request key already used with a different ${diff}`)
        return existing
      }
    }
    const id = input.id ?? `task-${crypto.randomUUID()}`
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO team_tasks
        (id, team_id, title, status, creator_kind, creator_session, parent_id, worktree, openspec_change, plan_id, plan_change, request_key, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        id, input.teamId, input.title, input.creator.kind, input.creator.sessionId,
        input.parentId ?? null, input.worktree ?? null, input.openspecChange ?? null,
        input.planId ?? null, input.planChange ?? null, input.requestKey ?? null, now, now,
      )
      this.insertRevision(id, 1, input.direction, input.acceptance ?? null, input.creator, now)
      within?.(this.get(id)!)
    })()
    return this.changed(id)
  }

  /** The task a team stored under a request key (idempotency reads). */
  byRequestKey(teamId: string, requestKey: string): TeamTask | null {
    const row = this.db.prepare('SELECT id FROM team_tasks WHERE team_id = ? AND request_key = ?').get(teamId, requestKey)
    return row ? this.get(String((row as Record<string, unknown>).id)) : null
  }

  get(id: string): TeamTask | null {
    const row = this.db.prepare(`SELECT t.*, r.direction, r.acceptance, p.title AS plan_title FROM team_tasks t
      JOIN team_task_revisions r ON r.task_id = t.id AND r.revision = t.revision
      LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = ?`).get(id)
    return row ? mapTask(row as Record<string, unknown>) : null
  }

  /** A team's tasks, oldest first, each with its participants. */
  list(teamId: string): TeamTaskSummary[] {
    return this.selectTasks('t.team_id = ?', teamId).map(task => this.summary(task))
  }

  detail(id: string): TeamTaskDetail | null {
    const task = this.get(id)
    if (!task) return null
    const revisions = this.revisions(id)
    return {
      task: this.summary(task),
      revisions,
      journal: this.journal(id),
      subtasks: this.selectTasks('t.parent_id = ?', id).map(child => this.summary(child)),
      assignments: this.assignments?.listByTask(id) ?? [],
      messages: this.messages(id),
      publications: this.notices?.publications(task, revisions) ?? [],
      acknowledgements: this.acknowledgements.list(id),
      results: this.results.listByTask(id).map(result => ({
        ...result,
        checks: this.checks.viewForResult(result.id),
        reviewerMaps: this.results.reviewerMapsOf(result.id, rawCoverage(result.coverage)),
      })),
    }
  }

  /** Every assignment of a task, oldest first; empty without an assignment store. */
  assignmentsOf(id: string): TeamTaskAssignment[] {
    return this.assignments?.listByTask(id) ?? []
  }

  /** The task's outstanding assignment (task-assignment D1); null without one or without an assignment store. */
  outstandingAssignment(id: string): TeamTaskAssignment | null {
    return this.assignments ? outstandingOf(this.assignments.listByTask(id)) : null
  }

  /** The human's view (D1): the detail plus the task's draft. Never for agent paths. */
  humanDetail(id: string): HumanTaskDetail | null {
    const detail = this.detail(id)
    return detail ? { ...detail, draft: this.drafts.get(id) } : null
  }

  revisions(id: string): TaskRevision[] {
    return (this.db.prepare('SELECT * FROM team_task_revisions WHERE task_id = ? ORDER BY revision').all(id) as Record<string, unknown>[])
      .map(row => ({
        revision: Number(row.revision),
        direction: String(row.direction),
        acceptance: text(row.acceptance),
        author: partyFromRow(row.author_kind, row.author_session),
        createdAt: String(row.created_at),
        rationale: text(row.rationale),
        notify: row.notify === null || row.notify === undefined ? null : Number(row.notify) === 1,
      }))
  }

  /** Oldest first; `limit` keeps only the most recent entries. */
  journal(id: string, limit?: number): TaskJournalEntry[] {
    const rows = (limit === undefined
      ? this.db.prepare('SELECT * FROM team_task_journal WHERE task_id = ? ORDER BY created_at, rowid').all(id)
      : this.db.prepare('SELECT * FROM (SELECT *, rowid AS r FROM team_task_journal WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, r').all(id, limit)
    ) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row.id),
      author: journalAuthor(row.author_kind, row.author_session),
      text: String(row.text),
      createdAt: String(row.created_at),
    }))
  }

  /**
   * Publish the next revision (task-revision-publication D2): one write
   * transaction that (1) resolves a keyed request against committed rows — a
   * same-payload replay returns the prior revision, a different payload is
   * refused naming the field — then (2) refuses a stale base naming the newer
   * revision, (3) inserts revision N+1 with its rationale, key, and notify
   * flag, bumps the task, and drops the draft it came from, and (4) runs
   * `within` (the notices, D3) before commit. The key check precedes the stale
   * check, so a replay after its own success is never refused as stale. The
   * `(task_id, request_key)` unique index is the arbiter: a concurrent
   * same-key insert rolls this one back and it resolves as a replay. Only a
   * new revision announces a change, after commit; a replay or a refusal
   * does not. Null for an unknown task.
   */
  publish(id: string, input: PublishInput, author: TaskActor, now = nowIso()): PublishOutcome | null {
    let outcome: PublishOutcome | null
    try {
      outcome = this.db.transaction((): PublishOutcome | null => {
        const prior = this.resolveKey(id, input)
        if (prior) return prior
        const current = this.get(id)
        if (!current) return null
        if (input.baseRevision !== undefined && input.baseRevision !== current.revision) {
          throw new Error(`Stale: revision ${current.revision} was published since revision ${input.baseRevision}; nothing was published. Rebase the draft onto revision ${current.revision}.`)
        }
        const next = current.revision + 1
        this.db.prepare('UPDATE team_tasks SET revision = ?, updated_at = ? WHERE id = ?').run(next, now, id)
        this.db.prepare(`INSERT INTO team_task_revisions
          (task_id, revision, direction, acceptance, author_kind, author_session, created_at, rationale, request_key, notify)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, next, input.direction ?? current.direction,
          input.acceptance === undefined ? current.acceptance : input.acceptance,
          author.kind, author.sessionId, now, input.rationale ?? null, input.requestKey ?? null, input.notify ? 1 : 0,
        )
        if (input.discardDraft) this.drafts.discard(id, false)
        const revision = this.revisions(id).at(-1)!
        input.within?.(revision, this.get(id)!)
        return { replay: false, task: this.get(id)!, revision }
      })()
    } catch (error) {
      // The arbiter (D2): a same-key publication committed between this
      // request's read and its write — the unique key rejected the insert, or
      // its revision made this base stale. Rolled back; resolve as its replay.
      const replay = this.resolveKey(id, input)
      if (replay) return replay
      throw error
    }
    if (!outcome || outcome.replay) return outcome
    return { ...outcome, task: this.changed(id) }
  }

  /** The committed revision a keyed publication already wrote, or null (D2 step 1). */
  private resolveKey(id: string, input: PublishInput): PublishOutcome | null {
    if (!input.requestKey) return null
    const row = this.db.prepare('SELECT revision FROM team_task_revisions WHERE task_id = ? AND request_key = ?')
      .get(id, input.requestKey) as { revision: number } | null
    if (!row) return null
    const revision = this.revisions(id).find(entry => entry.revision === row.revision)!
    const diff = publishPayloadDiff(revision, input)
    if (diff) throw new Error(`Request key already used with a different ${diff}; nothing was published`)
    return { replay: true, task: this.get(id)!, revision }
  }

  /** Run writes as one transaction (nested store transactions become savepoints). */
  atomically<T>(write: () => T): T {
    return this.db.transaction(write)()
  }

  appendJournal(id: string, author: JournalAuthor, entry: string, now = nowIso()): TaskJournalEntry | null {
    if (!this.get(id)) return null
    const journalId = `note-${crypto.randomUUID()}`
    this.db.prepare(`INSERT INTO team_task_journal (id, task_id, author_kind, author_session, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(journalId, id, author.kind, author.sessionId, entry, now)
    this.db.prepare('UPDATE team_tasks SET updated_at = ? WHERE id = ?').run(now, id)
    this.changed(id)
    return { id: journalId, author, text: entry, createdAt: now }
  }

  /**
   * Set a task's status. `within` runs inside the same transaction as the
   * update (member-release D1/D8): a transition into `done`/`cancelled`
   * records pending releases and dead-letters waiting mail atomically with
   * the new status, and a transition out cancels them. An actual change
   * also appends a `team_task_status_events` row (team-process-metrics D3)
   * naming `actor`; a same-status update records nothing.
   */
  setStatus(id: string, status: TaskStatus, within?: () => void, actor: JournalAuthor = SYSTEM_AUTHOR, now = nowIso()): TeamTask | null {
    const changes = this.db.transaction(() => {
      if (within) within()
      const before = this.db.prepare('SELECT status, team_id FROM team_tasks WHERE id = ?').get(id) as { status: string; team_id: string } | null
      if (!before) return 0
      if (before.status !== status) {
        this.db.prepare(`INSERT INTO team_task_status_events (task_id, team_id, from_status, to_status, actor_kind, actor_session, at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, before.team_id, before.status, status, actor.kind, actor.sessionId, now)
      }
      return this.db.prepare('UPDATE team_tasks SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id).changes
    })()
    return changes === 1 ? this.changed(id) : null
  }

  /** A task's recorded status transitions, oldest first (D3). */
  statusEvents(id: string): TaskStatusEvent[] {
    const rows = this.db.prepare('SELECT * FROM team_task_status_events WHERE task_id = ? ORDER BY id').all(id) as Record<string, unknown>[]
    return rows.map(row => ({
      fromStatus: row.from_status === null ? null : String(row.from_status) as TaskStatus,
      toStatus: String(row.to_status) as TaskStatus,
      actor: journalAuthor(row.actor_kind, row.actor_session),
      at: String(row.at),
    }))
  }

  /** Re-announce a task whose derived data (participants, messages) changed. */
  touch(id: string): void {
    if (this.get(id)) this.changed(id)
  }

  private insertRevision(id: string, revision: number, direction: string, acceptance: string | null, author: TaskCreator, now: string) {
    this.db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, revision, direction, acceptance, author.kind, author.sessionId, now)
  }

  private selectTasks(where: string, param: string): TeamTask[] {
    return (this.db.prepare(`SELECT t.*, r.direction, r.acceptance, p.title AS plan_title FROM team_tasks t
      JOIN team_task_revisions r ON r.task_id = t.id AND r.revision = t.revision
      LEFT JOIN plans p ON p.id = t.plan_id
      WHERE ${where} ORDER BY t.created_at, t.rowid`).all(param) as Record<string, unknown>[]).map(mapTask)
  }

  private messages(id: string) {
    return this.mail?.forTask(id) ?? []
  }

  /** A task as listed: its participants, assignment, and outstanding result. */
  summary(task: TeamTask): TeamTaskSummary {
    const ids = new Set<string>()
    if (task.creator.sessionId) ids.add(task.creator.sessionId)
    const rows = this.db.prepare(`
      SELECT session_id AS id FROM chat_sessions WHERE task_id = $id
      UNION SELECT from_session FROM team_messages WHERE task_id = $id AND from_session IS NOT NULL
      UNION SELECT claimed_by FROM team_messages WHERE task_id = $id AND claimed_by IS NOT NULL
      UNION SELECT author_session FROM team_task_journal WHERE task_id = $id AND author_session IS NOT NULL`)
      .all({ $id: task.id }) as Array<{ id: string }>
    for (const row of rows) ids.add(row.id)
    return { ...task, participants: [...ids], ...this.derived(task.id) }
  }

  /**
   * A task's outstanding assignment and result: the one derivation behind
   * `summary` and the agent's compact `task_list` rows (bounded-task-list D1).
   */
  derived(taskId: string): Pick<TeamTaskSummary, 'assignment' | 'outstandingResult'> {
    const result = this.results.outstanding(taskId)
    const findings = result ? this.results.findingsFor(result.id) : []
    return {
      assignment: this.assignments ? outstandingOf(this.assignments.listByTask(taskId)) : null,
      outstandingResult: result ? {
        id: result.id, needsReevaluation: result.needsReevaluation, accepted: result.acceptedAt !== null,
        reviewVerdict: findings.at(-1)?.verdict ?? null,
      } : null,
    }
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

const SYSTEM_AUTHOR: JournalAuthor = { kind: 'system', sessionId: null }

/** One recorded status transition; a null `fromStatus` marks a backfilled row. */
export interface TaskStatusEvent {
  fromStatus: TaskStatus | null
  toStatus: TaskStatus
  actor: JournalAuthor
  at: string
}

function actor(kind: unknown, session: unknown): TaskActor {
  return kind === 'agent' && typeof session === 'string' ? { kind: 'agent', sessionId: session } : { kind: 'human', sessionId: null }
}

/** A journal row's author: like `actor`, but `system` stays itself (D4, and plan-execution D2's Kawai). */
function journalAuthor(kind: unknown, session: unknown): JournalAuthor {
  return kind === 'system' ? { kind: 'system', sessionId: null } : actor(kind, session)
}

function mapTask(row: Record<string, unknown>): TeamTask {
  const status = String(row.status) as TaskStatus
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    title: String(row.title),
    status: TASK_STATUSES.includes(status) ? status : 'open',
    creator: partyFromRow(row.creator_kind, row.creator_session),
    parentId: text(row.parent_id),
    worktree: text(row.worktree),
    openspecChange: text(row.openspec_change),
    planId: text(row.plan_id),
    planChange: text(row.plan_change),
    planTitle: text(row.plan_title),
    revision: Number(row.revision),
    direction: String(row.direction),
    acceptance: text(row.acceptance),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}
