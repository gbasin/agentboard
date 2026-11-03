// The agent's bounded task list (bounded-task-list D1–D3), served by the
// `task_list` tool (taskTools) through `TaskService.agentList`.
// - The anchor check, the window, and the count run in one synchronous read
//   transaction, newest first by `(created_at, rowid)`, with the status
//   filter and the limit in SQL. No revision is joined, so a task's
//   direction and acceptance never reach JavaScript on this path.
// - Each returned row gets its assignee and result from `TaskStore.derived`,
//   the derivation behind the human's `TeamTaskSummary` too.
// - Without a status the filter is the open set (D2); `all` lifts it.
import type { Database } from 'bun:sqlite'
import type { AgentTaskList, AgentTaskRow, TaskListStatus, TaskStatus } from '../../shared/teamTasks'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { partyFromRow } from './actorRow'
import type { TaskStore } from './taskStore'

export const TASK_LIST_LIMIT_DEFAULT = 50
export const TASK_LIST_LIMIT_MAX = 200
/** The default filter (D2): work that is not finished. */
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['open', 'active', 'blocked']
export const TASK_LIST_STATUSES: readonly TaskListStatus[] = [...TASK_STATUSES, 'all']

export interface TaskListRequest {
  /** One status, `all`, or omitted for the open set. */
  status?: TaskListStatus
  /** 1–200, default 50. */
  limit?: number
  /** A task id of the team; the window holds matching tasks created strictly before it. */
  before?: string
}

/** The statuses a `status` argument applies (D2). */
export function appliedStatuses(status?: TaskListStatus): TaskStatus[] {
  if (status === undefined) return [...OPEN_TASK_STATUSES]
  if (status === 'all') return [...TASK_STATUSES]
  if (!TASK_STATUSES.includes(status)) throw new Error(`status must be one of ${TASK_LIST_STATUSES.join(', ')}: ${String(status)}`)
  return [status]
}

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value))

/** The store side: one SQL window over the team's tasks. */
export class TaskListWindow {
  constructor(private readonly db: Database, private readonly store: TaskStore) {}

  /** Throws for an unknown status, a limit outside 1–200, or an anchor that is not a task of the team. */
  agentList(teamId: string, request: TaskListRequest = {}): AgentTaskList {
    const statuses = appliedStatuses(request.status)
    const limit = request.limit ?? TASK_LIST_LIMIT_DEFAULT
    if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIST_LIMIT_MAX) {
      throw new Error(`limit must be an integer from 1 to ${TASK_LIST_LIMIT_MAX}: ${limit}`)
    }
    return this.db.transaction((): AgentTaskList => {
      const anchor = request.before === undefined ? null : this.anchor(teamId, request.before)
      const marks = statuses.map((_, i) => `$s${i}`).join(', ')
      const params: Record<string, string | number> = { $team: teamId }
      statuses.forEach((status, i) => { params[`$s${i}`] = status })
      const filter = `team_id = $team AND status IN (${marks})`
      const older = anchor ? 'AND (created_at < $at OR (created_at = $at AND rowid < $rowid))' : ''
      const rows = this.db.prepare(`SELECT id, title, status, creator_kind, creator_session, parent_id, worktree,
        openspec_change, plan_id, plan_change, revision, created_at, updated_at
        FROM team_tasks WHERE ${filter} ${older}
        ORDER BY created_at DESC, rowid DESC LIMIT $take`)
        .all({ ...params, $take: limit + 1, ...(anchor ? { $at: anchor.at, $rowid: anchor.rowid } : {}) }) as Record<string, unknown>[]
      const { total } = this.db.prepare(`SELECT COUNT(*) AS total FROM team_tasks WHERE ${filter}`).get(params) as { total: number }
      const tasks = rows.slice(0, limit).map(row => this.row(row))
      const truncated = rows.length > limit
      return {
        tasks, statuses,
        bounds: { total, returned: tasks.length, truncated, nextBefore: truncated ? tasks.at(-1)!.id : null },
      }
    })()
  }

  private anchor(teamId: string, taskId: string): { at: string; rowid: number } {
    const row = this.db.prepare('SELECT created_at AS at, rowid FROM team_tasks WHERE id = ? AND team_id = ?')
      .get(taskId, teamId) as { at: string; rowid: number } | null
    if (!row) throw new Error(`Unknown task for this team: ${taskId}`)
    return row
  }

  private row(row: Record<string, unknown>): AgentTaskRow {
    const id = String(row.id)
    const { assignment, outstandingResult } = this.store.derived(id)
    return {
      id,
      title: String(row.title),
      status: String(row.status) as TaskStatus,
      creator: partyFromRow(row.creator_kind, row.creator_session),
      parentId: text(row.parent_id),
      worktree: text(row.worktree),
      openspecChange: text(row.openspec_change),
      planId: text(row.plan_id),
      planChange: text(row.plan_change),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      assignee: assignment ? {
        targetKind: assignment.targetKind, targetId: assignment.targetId, role: assignment.role,
        claimedBy: assignment.claimedBy, state: assignment.state,
      } : null,
      result: outstandingResult ? {
        id: outstandingResult.id, reviewVerdict: outstandingResult.reviewVerdict,
        accepted: outstandingResult.accepted, needsReevaluation: outstandingResult.needsReevaluation,
      } : null,
    }
  }
}
