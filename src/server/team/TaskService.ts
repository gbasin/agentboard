// Task operations with identity and permissions (team-tasks design D2).
// Agent calls are bound to the calling session — its team, group, and
// creator identity come from the session record and the group files as they
// are now, never from tool arguments. Human calls arrive through the
// authenticated UI connection with a team already resolved. Rules:
// - create: the human, or an agent whose current group sets canCreateTasks;
// - amend direction/acceptance: the task's creator or the human;
// - journal notes and active/blocked: any member of the team, and the human;
// - done/cancelled: the creator; every status (including reopening): the human.
// References are validated before anything is written: parent tasks of the
// same team, worktrees listed for the team's repository (stored as their
// root), OpenSpec changes that exist, and a plan-change link to an open plan's
// approved revision (durable-plans D9).
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionRecord } from '../db'
import type { ActingParty } from '../../shared/team'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { AgentTaskList, TaskActor, TaskDraft, TaskStatus, TeamTask, TeamTaskDetail } from '../../shared/teamTasks'
import type { TaskListRequest } from './taskListWindow'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { StaleTaskStatus, type PreparedTaskStatus } from './taskStatusPrepared'
import { loadTeamGroups } from './teamGroups'
import type { TeamIdentity } from './teamIdentity'
import type { PublishOutcome, TaskStore } from './taskStore'
import type { NoticeSender, SentNotice } from './taskNotices'
import { TeamWorktrees } from './worktreeRoots'
import type { PlanStore } from '../plans/planStore'
import { resolvePlanLink } from '../plans/planLink'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import { executionOf, refuseSystem, type SystemCaller } from './systemCaller'
import { originStatusRefusal, statusRefusal } from './taskStatusRights'
export { statusRefusal } from './taskStatusRights'

export interface TaskCreateInput {
  title: string
  direction: string
  acceptance?: string | null
  parent_id?: string | null
  worktree?: string | null
  openspec_change?: string | null
  /** The plan-change link (durable-plans D9): both or neither; fixed at creation. */
  plan_id?: string | null
  plan_change?: string | null
  /** Stable client request key (task-assignment D4): replays deduplicate. */
  requestKey?: string | null
}

export interface TaskAmendInput {
  direction?: string
  acceptance?: string | null
  /** Why (task-revision-publication D2); required by the human form, optional for agents. */
  rationale?: string | null
  /** Publish and notify (D3): direct notices to the outstanding assignment's claimant. */
  notify?: boolean
}

/** A publication (D2): an amendment plus the human UI's base revision and command key. */
export interface TaskPublishInput extends TaskAmendInput {
  baseRevision?: number
  requestKey?: string
  /** The human published their saved draft: it is discarded with the publication (D2). */
  fromDraft?: boolean
}

/**
 * The optional in-process revision-published announcement (D8), fired once
 * after a new revision commits. It carries nothing the revision rows lack:
 * consumers compare against `team_task_revisions` and `team_tasks.revision`.
 */
export interface RevisionPublishedEvent {
  teamId: string
  taskId: string
  revision: number
  previousRevision: number
  author: ActingParty
  rationale: string | null
  publishedAt: string
}

/** The human's draft of a new direction (task-revision-publication D1). */
export interface TaskDraftInput {
  /** The published revision it edits; the current one when omitted. */
  baseRevision?: number
  direction: string
  acceptance?: string | null
  rationale?: string | null
}

/**
 * Who is calling: an agent session (identity bound), the human for a team, or
 * Kawai (`systemCaller.ts`: a plan execution, an override, or a failed
 * promotion, each with its own rights). Only the execution module and
 * `fixTasks.ts` mint the system caller; tools and connections build `agent`
 * and `human`.
 */
export type TaskCaller =
  | { kind: 'agent'; sessionId: string }
  | { kind: 'human'; team: TeamIdentity }
  | SystemCaller

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** How often setStatus re-prepares when the status moves during its hook's await. */
const STATUS_ATTEMPTS = 3

export class TaskService {
  readonly worktrees: TeamWorktrees
  private readonly publishedListeners = new Set<(event: RevisionPublishedEvent) => void>()

  constructor(readonly store: TaskStore, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    homeDir?: string
    worktrees?: TeamWorktrees
    /**
     * A status transition into or out of `done`/`cancelled` (member-release
     * D1/D8): resolved first, then run inside the status transaction.
     */
    onStatusTransition?: (task: TeamTask, status: TaskStatus, actor: ActingParty) => Promise<() => void>
    /** Restore an archived notice recipient after commit (direct mail resumes it, D3/Q8). */
    restoreSession?: (id: string) => void | Promise<void>
    /** Plans a task may link to (durable-plans D9); without it every link is refused as unknown. */
    plans?: PlanStore
    /** What a running execution owns (plan-execution D7); the default owns nothing. */
    ownership?: ExecutionOwnership
  }) {
    this.worktrees = options.worktrees ?? new TeamWorktrees()
  }

  async create(caller: TaskCaller, input: TaskCreateInput): Promise<TeamTask> {
    refuseSystem(caller, 'create-linked')
    const { team, actor, canCreate } = await this.context(caller)
    if (actor.kind === 'system' && !(input.plan_id && input.plan_change)) {
      throw new Error('Kawai creates a task only with its execution\'s plan-change link')
    }
    if (!canCreate) {
      throw new Error("Your group cannot create tasks (its group file does not set canCreateTasks: true). Ask a team lead or the human to create one.")
    }
    const title = input.title.trim()
    const direction = input.direction.trim()
    if (!title) throw new Error('A task needs a title')
    if (!direction) throw new Error('A task needs a direction')
    if (input.parent_id) this.sameTeamTask(team, input.parent_id, 'Parent task')
    let worktree: string | null = null
    if (input.worktree) {
      const target = await this.worktrees.resolveTarget(team.teamId, input.worktree)
      if (!target.ok) throw new Error(target.error)
      worktree = target.root
    }
    const openspecChange = input.openspec_change ? this.validateChange(team, input.openspec_change, worktree) : null
    const ownership = this.options.ownership ?? NULL_OWNERSHIP
    let linkRevision: number | null | undefined
    if (caller.kind === 'system') {
      // Kawai links to the revision its execution runs, which a later
      // approved revision may have left behind (plan-execution D7). Without
      // a wiring (the team services alone) there is no execution to read,
      // and the link resolves against the current approved revision.
      const executionId = executionOf(caller)
      const execution = executionId === null ? null : ownership.revisionOf(executionId)
      if (execution) {
        if (input.plan_id && execution.planId !== input.plan_id.trim()) {
          throw new Error(`Kawai's tasks link to the plan of their execution (${execution.planId}), not ${input.plan_id}.`)
        }
        linkRevision = execution.revision
      }
    } else if (input.plan_change) {
      // The ownership guard runs before the link resolution so the refusal
      // names the execution, whatever the plan's current revision lists.
      const owner = ownership.ownerOfChange(team.teamId, input.plan_change.trim())
      if (owner) {
        throw new Error(`Change "${input.plan_change.trim()}" is owned by a running execution (${owner.executionId}); another task for it must wait until the execution finishes.`)
      }
    }
    const link = resolvePlanLink(this.options.plans, team.teamId, input.plan_id, input.plan_change, linkRevision)
    return this.store.create({
      teamId: team.teamId, title, direction, acceptance: emptyToNull(input.acceptance), creator: actor,
      parentId: input.parent_id || null, worktree, openspecChange,
      ...(link ? { planId: link.planId, planChange: link.planChange } : {}),
      ...(input.requestKey ? { requestKey: input.requestKey } : {}),
    })
  }

  /**
   * Kawai's fix or correction task (plan-supervision D7): no worktree, change,
   * parent, or plan link. Synchronous so the override's transaction holds it;
   * `within` writes the `plan_fix_tasks` row in the task's own transaction.
   */
  createFixTask(caller: SystemCaller, input: { id?: string; title: string; direction: string; acceptance: string }, within: (task: TeamTask) => void): TeamTask {
    refuseSystem(caller, 'create-fix')
    const title = input.title.trim()
    const direction = input.direction.trim()
    if (!title || !direction) throw new Error('A fix task needs a title and a direction')
    return this.store.create({ id: input.id, teamId: caller.team.teamId, title, direction, acceptance: emptyToNull(input.acceptance), creator: SYSTEM_ACTOR }, undefined, within)
  }

  async get(caller: TaskCaller, taskId: string): Promise<TeamTaskDetail> {
    refuseSystem(caller, 'read')
    const { team } = await this.context(caller)
    this.sameTeamTask(team, taskId)
    return this.store.detail(taskId)!
  }

  /** The agent's `task_list` (bounded-task-list D3): compact rows, the open set by default, bounded and paged. */
  async agentList(caller: TaskCaller, request: TaskListRequest = {}): Promise<AgentTaskList> {
    refuseSystem(caller, 'read')
    const { team } = await this.context(caller)
    return this.store.listWindow.agentList(team.teamId, request)
  }

  /** The agent tool's path (D7): publish immediately, with optional rationale and notify. */
  async amend(caller: TaskCaller, taskId: string, change: TaskAmendInput): Promise<TeamTask> {
    return (await this.publish(caller, taskId, change)).task
  }

  /**
   * Publish the next revision (D2): the creator or the human only. The human
   * UI sends the draft's base revision and a command key, so a resend is a
   * replay and a stale base is refused; the agent tool sends neither. A
   * human publication drops the draft it came from. Announced once after a
   * new revision commits — never on a replay.
   */
  async publish(caller: TaskCaller, taskId: string, input: TaskPublishInput): Promise<PublishOutcome> {
    const { team, actor } = await this.revisionPublisher(caller)
    const task = this.sameTeamTask(team, taskId)
    if (actor.kind === 'agent' && task.creator.sessionId !== actor.sessionId) {
      throw new Error(`Only the task's creator or the human can amend its direction. Add a journal note with task_note, or message the creator${task.creator.sessionId ? ` (${task.creator.sessionId})` : ' (the human)'} instead.`)
    }
    if (input.direction === undefined && input.acceptance === undefined) throw new Error('Nothing to amend: give a direction or acceptance criteria')
    if (input.direction !== undefined && !input.direction.trim()) throw new Error('A task needs a direction')
    // Refused before anything is written, as notify() refuses: never a notify revision without its notices.
    if (input.notify && !this.store.notices) throw new Error('Revision notices are not available')
    const sender = this.noticeSender(team, actor)
    const requestKey = input.requestKey?.trim() || undefined
    let sent: SentNotice[] = []
    const outcome = this.store.publish(taskId, {
      ...(input.direction !== undefined ? { direction: input.direction.trim() } : {}),
      ...(input.acceptance !== undefined ? { acceptance: emptyToNull(input.acceptance) } : {}),
      rationale: emptyToNull(input.rationale),
      ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
      ...(input.requestKey?.trim() ? { requestKey: input.requestKey.trim() } : {}),
      notify: input.notify === true,
      // Only the publication that came from the draft discards it (D2).
      discardDraft: actor.kind === 'human' && input.fromDraft === true,
      // Publish and notify (D3): the notices commit or roll back with the revision.
      ...(input.notify && this.store.notices ? {
        within: (revision, current) => {
          sent = this.store.notices!.write(current, revision, {
            sender, requestKey: requestKey ?? `publish-r${revision.revision}`, sessionExists: id => !!this.options.getSession(id),
          })
        },
      } : {}),
    }, actor)
    if (!outcome) throw new Error(`Task not found in this team: ${taskId}`)
    if (!outcome.replay) this.announce(outcome)
    await this.restoreRecipients(sent)
    return outcome
  }

  /**
   * Notify, or retry a failed notice (D4): send the published revision to
   * each assignment holder that has neither received it nor holds a pending
   * notice for it, under the command's key; a replay sends nothing more.
   * Never creates a revision. The creator or the human.
   */
  async notify(caller: TaskCaller, taskId: string, revision: number, requestKey: string): Promise<{ replay: boolean; notices: SentNotice[]; task: TeamTask }> {
    const { team, actor } = await this.revisionPublisher(caller)
    const task = this.sameTeamTask(team, taskId)
    if (actor.kind === 'agent' && task.creator.sessionId !== actor.sessionId) {
      throw new Error("Only the task's creator or the human can send revision notices.")
    }
    const key = requestKey.trim()
    if (!key) throw new Error('A notification needs a request key')
    const published = this.store.revisions(taskId).find(entry => entry.revision === revision)
    if (!published) throw new Error(`Revision ${revision} of this task is not published`)
    if (!this.store.notices) throw new Error('Revision notices are not available')
    const outcome = this.store.notices.notify(task, published, {
      sender: this.noticeSender(team, actor), requestKey: key, sessionExists: id => !!this.options.getSession(id),
    })
    if (!outcome.replay) await this.restoreRecipients(outcome.notices)
    return { ...outcome, task: this.store.get(taskId)! }
  }

  /**
   * An agent states the published revision it works from (D6): bound to the
   * calling session, refused for another team's task and for any revision
   * not yet published — so a draft can never be acknowledged. Recorded with
   * the session's outstanding assignment, if it holds one; a repeat is a
   * no-op. Older revisions are recorded too: that is true information.
   */
  async acknowledge(caller: TaskCaller, taskId: string, revision: number): Promise<{ taskId: string; revision: number; alreadyAcknowledged: boolean }> {
    refuseSystem(caller, 'acknowledge')
    const { team, actor } = await this.context(caller)
    if (actor.kind !== 'agent') throw new Error('Only agents acknowledge revisions')
    const task = this.sameTeamTask(team, taskId)
    if (!Number.isInteger(revision) || revision < 1 || revision > task.revision) {
      throw new Error(`Revision ${revision} of task ${taskId} is not published; its current revision is ${task.revision}.`)
    }
    const holder = this.store.notices?.holders(taskId).find(entry => entry.sessionId === actor.sessionId)
    const recorded = this.store.acknowledgements.record(taskId, actor.sessionId, revision, holder?.assignmentId ?? null)
    // The publication detail shows acknowledgements live (D5).
    if (recorded) this.store.touch(taskId)
    return { taskId, revision, alreadyAcknowledged: !recorded }
  }

  /** The publisher as the notice's sender (D3): the human, or the creating agent from its session. */
  private noticeSender(team: TeamIdentity, actor: TaskActor): NoticeSender {
    if (actor.kind === 'human') return { actor, fromGroup: null, originPath: team.groupsRoot }
    const session = this.options.getSession(actor.sessionId)
    return { actor, fromGroup: session?.groupId ?? null, originPath: session?.projectPath ?? team.groupsRoot }
  }

  /** Direct mail resumes an archived recipient (agent-mailbox), after the notice committed. */
  private async restoreRecipients(sent: SentNotice[]): Promise<void> {
    for (const notice of sent) {
      if (this.options.getSession(notice.sessionId)?.archivedAt) await this.options.restoreSession?.(notice.sessionId)
    }
  }

  /** Subscribe to new revisions (D8); optional — no consumer may depend on it. */
  onRevisionPublished(listener: (event: RevisionPublishedEvent) => void): () => void {
    this.publishedListeners.add(listener)
    return () => this.publishedListeners.delete(listener)
  }

  private announce({ task, revision }: PublishOutcome): void {
    const event: RevisionPublishedEvent = {
      teamId: task.teamId, taskId: task.id, revision: revision.revision, previousRevision: revision.revision - 1,
      author: revision.author, rationale: revision.rationale ?? null, publishedAt: revision.createdAt,
    }
    for (const listener of this.publishedListeners) listener(event)
  }

  /**
   * Save the human's draft (D1). Agents have none — their working context is
   * already a draft, so they publish with task_amend. Nothing is published,
   * mailed, or announced as a task change; only the human's view refreshes.
   */
  async saveDraft(caller: TaskCaller, taskId: string, input: TaskDraftInput): Promise<TaskDraft> {
    const task = await this.humanTask(caller, taskId)
    const direction = input.direction.trim()
    if (!direction) throw new Error('A draft needs a direction')
    const baseRevision = input.baseRevision ?? task.revision
    if (!Number.isInteger(baseRevision) || baseRevision < 1 || baseRevision > task.revision) {
      throw new Error(`A draft must be based on a published revision (1–${task.revision})`)
    }
    return this.store.drafts.save(taskId, {
      baseRevision, direction, acceptance: emptyToNull(input.acceptance), rationale: emptyToNull(input.rationale),
    })
  }

  /** Move the draft onto the current revision, keeping its text (D1). */
  async rebaseDraft(caller: TaskCaller, taskId: string): Promise<TaskDraft> {
    const task = await this.humanTask(caller, taskId)
    const draft = this.store.drafts.rebase(taskId, task.revision)
    if (!draft) throw new Error('This task has no draft to rebase')
    return draft
  }

  async discardDraft(caller: TaskCaller, taskId: string): Promise<void> {
    await this.humanTask(caller, taskId)
    this.store.drafts.discard(taskId)
  }

  async note(caller: TaskCaller, taskId: string, text: string) {
    refuseSystem(caller, 'note')
    const { team, actor } = await this.context(caller)
    this.sameTeamTask(team, taskId)
    if (!text.trim()) throw new Error('A journal note needs text')
    return this.store.appendJournal(taskId, actor, text.trim())!
  }

  /**
   * Set a task's status. `alsoWithin` runs inside the status transaction,
   * after the transition hook's closure — acceptance (task-results-handoffs
   * D5) commits its result mark and journal entry with the `done` status.
   */
  async setStatus(caller: TaskCaller, taskId: string, status: TaskStatus, note?: string, alsoWithin?: () => void): Promise<TeamTask> {
    // The closed/open boundary is decided on a snapshot; preparing its hook
    // awaits group definitions, so the status may move meanwhile. A stale
    // commit prepares again on the fresh status, and refuses after a few.
    for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt++) {
      const prepared = await this.prepareStatus(caller, taskId, status, note)
      try {
        return prepared.commit(alsoWithin)
      } catch (error) {
        if (!(error instanceof StaleTaskStatus)) throw error
      }
    }
    throw new Error(`Task ${taskId} kept changing status while this update was prepared (now ${this.store.get(taskId)?.status ?? 'gone'}); nothing changed. Try again.`)
  }

  /**
   * The two phases of a status change (plan-execution D12). Preparing is
   * async: it resolves the caller, checks the refusal, and prepares the
   * transition hook (member release's close hook). `commit` is synchronous,
   * so a caller can run it inside its own transaction; it throws
   * StaleTaskStatus, writing nothing, when the task's status moved since
   * the preparation. `alsoWithin` runs inside the status transaction, after
   * the hook's closure — acceptance (task-results-handoffs D5) commits its
   * result mark and journal entry with the `done` status.
   */
  async prepareStatus(caller: TaskCaller, taskId: string, status: TaskStatus, note?: string): Promise<PreparedTaskStatus> {
    const { team, actor } = await this.context(caller)
    const task = this.sameTeamTask(team, taskId)
    if (!TASK_STATUSES.includes(status)) throw new Error(`Unknown task status: ${String(status)}`)
    refuseSystem(caller, status === 'done' || status === 'cancelled' ? 'close' : 'status')
    const refusal = statusRefusal(actor, task, status) ?? (caller.kind === 'system' ? originStatusRefusal(caller.origin, task) : null)
    if (refusal) throw new Error(refusal)
    const hook = this.crossesBoundary(task.status, status)
      ? await this.options.onStatusTransition!(task, status, actor)
      : undefined
    const expected = task.status
    return {
      commit: (alsoWithin?: () => void): TeamTask => {
        const fresh = this.store.get(taskId)
        if (!fresh) throw new Error(`Unknown task: ${taskId}`)
        if (fresh.status !== expected) throw new StaleTaskStatus(taskId, fresh.status)
        const within = hook && alsoWithin ? () => { hook(); alsoWithin() } : hook ?? alsoWithin
        if (note?.trim()) this.store.appendJournal(taskId, actor, note.trim())
        return this.store.setStatus(taskId, status, within, actor)!
      },
    }
  }

  /** Whether moving from `from` to `to` crosses the closed/open boundary the transition hook handles. */
  private crossesBoundary(from: TaskStatus, to: TaskStatus): boolean {
    if (!this.options.onStatusTransition || from === to) return false
    return (from === 'done' || from === 'cancelled') !== (to === 'done' || to === 'cancelled')
  }

  /** The caller's team, actor identity, and current creation right (TaskResultService resolves callers here too). */
  async context(caller: TaskCaller): Promise<{ team: TeamIdentity; actor: ActingParty; canCreate: boolean }> {
    switch (caller.kind) {
      case 'human':
        return { team: caller.team, actor: { kind: 'human', sessionId: null }, canCreate: true }
      case 'system':
        return { team: caller.team, actor: SYSTEM_ACTOR, canCreate: true }
      case 'agent': {
        const session = this.options.getSession(caller.sessionId)
        if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
        // Read at call time: an edited group file applies to the next call.
        const { team, catalog } = await loadTeamGroups(session.projectPath, this.options.homeDir)
        const group = session.groupId ? catalog.groups.get(session.groupId)?.group : undefined
        return { team, actor: { kind: 'agent', sessionId: session.sessionId }, canCreate: group?.canCreateTasks === true }
      }
      default: {
        const never: never = caller
        throw new Error(`Unknown caller: ${JSON.stringify(never)}`)
      }
    }
  }

  /** Publishing a revision and sending notices: the creator agent or the human, never Kawai (D2). */
  private async revisionPublisher(caller: TaskCaller): Promise<{ team: TeamIdentity; actor: TaskActor }> {
    const { team, actor } = await this.context(caller)
    if (actor.kind === 'system') throw new Error('Kawai never publishes a task revision or sends its notices; only the creator or the human does.')
    return { team, actor }
  }

  /** A task of the human caller's team; agents are refused (drafts are the human's, D1/D7). */
  private async humanTask(caller: TaskCaller, taskId: string): Promise<TeamTask> {
    if (caller.kind !== 'human') throw new Error("Drafts are the human's; agents publish directly with task_amend")
    const { team } = await this.context(caller)
    return this.sameTeamTask(team, taskId)
  }

  /** The task, if it belongs to the team; otherwise an error that leaks nothing. */
  sameTeamTask(team: TeamIdentity, taskId: string, label = 'Task'): TeamTask {
    const task = this.store.get(taskId)
    if (!task || task.teamId !== team.teamId) throw new Error(`${label} not found in this team: ${taskId}`)
    return task
  }

  /** An active change in the main checkout or in the task's worktree. */
  private validateChange(team: TeamIdentity, name: string, worktree: string | null): string {
    const change = name.trim()
    const roots = [team.groupsRoot, ...(worktree ? [worktree] : [])]
    const isChange = (root: string) => {
      try { return fs.statSync(path.join(root, 'openspec', 'changes', change)).isDirectory() } catch { return false }
    }
    if (CHANGE_NAME.test(change) && change !== 'archive' && roots.some(isChange)) {
      return change
    }
    throw new Error(`OpenSpec change not found: ${name} (looked in ${roots.map(root => path.join(root, 'openspec', 'changes')).join(' and ')})`)
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null
}
