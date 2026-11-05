// Assignment operations (task-assignment design D3/D4/D6/D7/D8): dispatch an
// instruction to a group or a session as the human, idempotently under a
// client request key; reassign explicitly (supersede, cancel-on-stop, notify);
// preview a dispatch read-only from the same sources the dispatcher uses; and
// list the team-scoped worktree/change targets the pickers offer.
//
// Dispatch is one SQLite transaction: the assignment row and its instruction
// mail commit together (or not at all), so an accepted dispatch always has its
// mail and a refusal writes nothing. The instruction is an ordinary
// `team_messages` row — sender is the human on the actor model
// `team-message-threads` ships (`from_kind: 'human'`, no sender session,
// origin = the team's main checkout root); this service adds no sender schema.
// Group targets ride the existing delivery rules untouched: one eligible
// member, worktree filtering, bounded spawning, transcript-confirmed receipts.
// Dispatch never changes task status (D9) and never creates a worktree.
import fs from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type {
  AssignmentTarget,
  TaskDispatchPreview,
  TaskTargetOptions,
  TaskHandoffKind,
  TeamTask,
  TeamTaskAssignment,
} from '../../shared/teamTasks'
import type { TaskCreator } from '../../shared/teamTasks'
import { loadGroupCatalog } from './groupCatalog'
import { partyName } from './actorRow'
import { resolveTeam, type TeamIdentity } from './teamIdentity'
import type { AssignmentStore } from './assignmentStore'
import { handoffDiff, outstandingOf, type DispatchHandoff } from './assignmentStore'
export type { DispatchHandoff } from './assignmentStore'
import type { MailboxStore, TeamMessage } from './mailboxStore'
import type { TaskStore } from './taskStore'
import type { TaskCaller } from './TaskService'
import { refuseSystem, type SystemCaller } from './systemCaller'
import type { GroupDefinition } from './groupFile'
import { checkWorkerChoice, WORKER_GROUP_TARGET_ONLY } from './workerChoiceCheck'
import type { TeamCaps } from './teamCaps'
import type { WorktreeStaffing } from './staffing'
import type { MailRecipient } from './dispatcher'
import { ambientProviderOf } from './cooldowns'
import { previewGroupDispatch } from './groupDispatchPreview'
import { liveGroupMembers } from './routing/router'
import { worktreeRootOf, type TeamWorktrees } from './worktreeRoots'
import type { PlanStore } from '../plans/planStore'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'

/** How an outstanding assignment is handled by a reassignment (D7). */
export type ReassignHandling = 'notify' | 'stop'

export interface DispatchInput {
  taskId: string
  target: AssignmentTarget
  instruction: string
  /** The dispatch identity (D4): stable across retries of one user intent. */
  requestKey: string
  /** Required when the task has an outstanding assignment (D7) — except for a handoff. */
  handling?: ReassignHandling
  /**
   * A handoff (task-results-handoffs D3): its kind, referenced result, and
   * expected response, recorded on the assignment and part of the key's
   * payload identity. A handoff is the task's next stage: it supersedes the
   * outstanding assignment through the **stop** branch, with no choice asked.
   */
  handoff?: DispatchHandoff
  /**
   * The role's profiles the dispatch may route to (plan-execution D15),
   * carried on the instruction mail. Honored for the system caller only;
   * anyone else passing them is refused.
   */
  allowedProfiles?: string[]
  /** Tags on the instruction mail (plan-execution D7); the system caller only. */
  tags?: string[]
  /**
   * The worker choice (dispatch-worker-choice D1/D7), as on group mail: a
   * group target only, normalized before anything is written, carried on the
   * row and the instruction mail, and part of the key's payload identity.
   * Kawai's dispatches never carry one (roles alone narrow them).
   */
  worker?: string
}


export interface DispatchOutcome {
  /** True when the request key returned a prior, identical dispatch. */
  replay: boolean
  assignment: TeamTaskAssignment
  /** The instruction mail (the prior one on replay). */
  message: TeamMessage | null
}

const CHANGE_NAME = /^[a-z0-9][a-z0-9-]*$/
const nowIso = () => new Date().toISOString()

const HANDOFF_LABELS: Record<TaskHandoffKind, string> = { review: 'Review', qa: 'QA', fix: 'Fix' }

export const targetLabel = (target: AssignmentTarget) => (target.kind === 'group' ? `group ${target.id}` : `session ${target.id}`)

const stateLabel = (assignment: TeamTaskAssignment) =>
  assignment.claimedBy ? `${assignment.state} (claimed by ${assignment.claimedBy})` : assignment.state

export class AssignmentService {
  constructor(private readonly db: Database, private readonly store: AssignmentStore, private readonly tasks: TaskStore,
    private readonly mail: MailboxStore, private readonly options: {
      getSession: (id: string) => ChatSessionRecord | null | undefined
      /** Every live chat session record (archived ones included; filtered here). */
      records: () => Iterable<ChatSessionRecord>
      /** A session's resolved team; undefined while resolving. */
      teamOf: (sessionId: string) => TeamIdentity | undefined
      staffing: WorktreeStaffing
      caps: TeamCaps
      worktrees: TeamWorktrees
      homeDir?: string
      /** Plan records, for the task form's plan and change pickers. */
      plans?: PlanStore
      /** Built-in cooldown end (ISO) of a profile, or null (preview skips cooling profiles). */
      cooldownUntil?: (profileId: string) => string | null
      /** A member's recipient facts as the dispatcher states them (the preview's member predicates); without it no member previews as idle. */
      recipient?: (sessionId: string) => MailRecipient | undefined
      /** What a running execution owns (plan-execution D7); the default owns nothing. */
      ownership?: ExecutionOwnership
    }) {}

  /**
   * Dispatch an instruction under a request key (D3/D4/D7). Validation first,
   * then one transaction: reassignment writes (supersession, cancel-on-stop,
   * notify note), the assignment row, the instruction mail, and the journal
   * entry. A same-key replay of a completed dispatch — including a
   * reassignment — returns the prior outcome and writes nothing.
   */
  async dispatch(caller: TaskCaller, input: DispatchInput): Promise<DispatchOutcome> {
    refuseSystem(caller, input.handoff ? 'handoff' : 'dispatch')
    const team = await this.teamOf(caller)
    const checked = this.checkDispatch(caller, team, input)
    const recipient = await this.sessionTarget(team, input.target)
    return this.commitDispatch(caller, team, input, checked, recipient)
  }

  /**
   * Kawai's dispatch of a fix or correction task inside the caller's own
   * transaction (plan-supervision D7): a group target, so nothing awaits.
   */
  dispatchWithin(caller: SystemCaller, input: DispatchInput): DispatchOutcome {
    refuseSystem(caller, input.handoff ? 'handoff' : 'dispatch')
    if (input.target.kind !== 'group') throw new Error('Kawai dispatches a fix task to a group only')
    return this.commitDispatch(caller, caller.team, input, this.checkDispatch(caller, caller.team, input), null)
  }

  /** The dispatch's synchronous refusals, before anything is written. */
  private checkDispatch(caller: TaskCaller, team: TeamIdentity, input: DispatchInput): { task: TeamTask; instruction: string; requestKey: string; workerChoice: string | null } {
    const task = this.tasks.get(input.taskId)
    if (!task || task.teamId !== team.teamId) throw new Error(`Task not found in this team: ${input.taskId}`)
    // A decision origin dispatches only the fix and correction tasks Kawai created (D7).
    if (caller.kind === 'system' && caller.origin.kind !== 'execution' && (task.planId || task.creator.kind !== 'system')) {
      throw new Error('Kawai dispatches for a decision only its own fix and correction tasks.')
    }
    // Only Kawai dispatches a running change's task (plan-execution D7): the
    // human and agents are refused naming the execution, with the way out.
    const owner = (this.options.ownership ?? NULL_OWNERSHIP).ownerOfTask(input.taskId)
    if (owner !== null && caller.kind !== 'system') {
      throw new Error(`The task is owned by a running execution (${owner.executionId}); close the task or stop the execution instead. Nothing was written.`)
    }
    if (caller.kind !== 'system' && (input.allowedProfiles !== undefined || input.tags !== undefined)) {
      throw new Error('Only Kawai restricts a dispatch to role profiles or tags it; drop allowedProfiles and tags.')
    }
    const instruction = input.instruction.trim()
    if (!instruction) throw new Error('An assignment instruction is needed')
    const requestKey = input.requestKey.trim()
    if (!requestKey) throw new Error('A dispatch needs a request key')
    // Target validation before anything is written: a catalog group, or a
    // live non-archived session of this team (sessionTarget).
    if (input.target.kind === 'group') this.groupOf(team, input.target.id)
    return { task, instruction, requestKey, workerChoice: this.workerChoice(caller, team, input.target, input.worker) }
  }

  /**
   * The canonical worker choice of a dispatch or handoff (dispatch-worker-choice
   * D1/D7), or null without one. Refused naming the reason for Kawai, for a
   * session target, and for an unknown, ambiguous, or out-of-group worker.
   */
  workerChoice(caller: TaskCaller, team: TeamIdentity, target: AssignmentTarget, raw: string | undefined): string | null {
    if (raw === undefined) return null
    if (caller.kind === 'system') throw new Error("Kawai's dispatches carry no worker choice; roles alone narrow them.")
    if (target.kind !== 'group') throw new Error(WORKER_GROUP_TARGET_ONLY)
    return checkWorkerChoice(raw, this.groupOf(team, target.id), this.options.homeDir, team.groupsRoot)
  }

  private commitDispatch(caller: TaskCaller, team: TeamIdentity, input: DispatchInput,
    { task, instruction, requestKey, workerChoice }: { task: TeamTask; instruction: string; requestKey: string; workerChoice: string | null }, recipient: ChatSessionRecord | null): DispatchOutcome {
    const role = input.target.kind === 'group' ? input.target.id : recipient?.groupId ?? null

    // The replay path resolves against committed rows before anything is
    // written: a reconnect resend, a double click, or a crash-then-retry can
    // never add a second instruction (D4).
    const existing = this.store.byKey(team.teamId, requestKey)
    if (existing) {
      const diff = this.payloadDiff(existing, task.id, { target: input.target, instruction, workerChoice, handoff: input.handoff ?? null })
      if (diff) throw new Error(`Request key already used with a different ${diff}`)
      return { replay: true, assignment: existing, message: existing.messageId ? this.mail.get(existing.messageId) : null }
    }

    // The dispatcher: the human, an agent (task_handoff) sending as itself, or Kawai.
    const { creator, sender } = this.dispatcher(caller, team)
    const message = this.db.transaction(() => {
      const outstanding = outstandingOf(this.store.listByTask(task.id))
      if (outstanding && !input.handling && !input.handoff) {
        throw new Error(`Task already has an outstanding assignment: ${targetLabel({ kind: outstanding.targetKind, id: outstanding.targetId })}, ${stateLabel(outstanding)}. Choose notify or stop to reassign.`)
      }
      const inserted = this.store.insert({
        teamId: team.teamId, taskId: task.id, requestKey,
        targetKind: input.target.kind, targetId: input.target.id, role, instruction, creator,
        ...(input.handoff ? { handoff: input.handoff } : {}), ...(workerChoice ? { workerChoice } : {}),
      })
      const enqueued = this.mail.enqueue({
        teamId: team.teamId, toKind: input.target.kind, toId: input.target.id,
        ...sender, priority: 'normal', body: instruction, taskId: task.id,
        ...(input.allowedProfiles ? { allowedProfiles: input.allowedProfiles } : {}),
        ...(input.tags ? { tags: [...new Set(input.tags)] } : {}), ...(workerChoice ? { workerChoice } : {}),
      })
      this.store.setMessage(inserted.assignment.id, enqueued.id)
      const by = creator.kind === 'human' ? 'human' : partyName(creator)
      this.tasks.appendJournal(task.id, creator, input.handoff
        ? `${HANDOFF_LABELS[input.handoff.kind]} handoff of result ${input.handoff.resultId} to ${targetLabel(input.target)} by ${by}`
        : `Assigned to ${targetLabel(input.target)} by ${by}`)
      // A handoff is the task's next stage (pin 11): the stop branch, so an
      // undelivered predecessor never delivers later. The key replay above
      // and task_handoff's equivalent check run first, so a retry never
      // supersedes its own handoff.
      const handling = input.handoff ? 'stop' : input.handling
      if (outstanding && handling) {
        this.replace(outstanding, handling, task, input.target, team, inserted.assignment.id, creator,
          input.handoff ? `the ${input.handoff.kind} handoff` : `reassignment (${handling})`)
      }
      return enqueued
    })()
    const assignment = this.store.byKey(team.teamId, requestKey)!
    return { replay: false, assignment, message: this.mail.get(message.id) }
  }

  /**
   * Reassignment writes (D7), inside the dispatch transaction: supersede the
   * old row, and per the human's choice either cancel the old instruction
   * (only while queued or waiting on a pending request — a `spawning`
   * reservation is left to staffing's lifecycle, claimed or delivered work is
   * never touched, nobody is killed or archived) or send the previous claimed
   * agent a fixed normal-priority direct note.
   */
  private replace(outstanding: TeamTaskAssignment, handling: ReassignHandling, task: TeamTask, target: AssignmentTarget, team: TeamIdentity,
    newId: string, actor: TaskCreator, supersededBy: string): void {
    const previous = { kind: outstanding.targetKind as 'group' | 'session', id: outstanding.targetId }
    if (handling === 'stop') {
      // Only while queued or awaiting a request: the store's cancel also takes parked work, which stop never touches.
      const state = outstanding.messageId ? this.mail.get(outstanding.messageId)?.state : undefined
      if (state === 'queued' || state === 'awaiting-request') this.mail.cancel(outstanding.messageId!, actor.kind === 'agent' ? { kind: 'agent', sessionId: actor.sessionId } : { kind: actor.kind })
    } else if (outstanding.claimedBy && this.options.getSession(outstanding.claimedBy)) {
      this.mail.enqueue({
        teamId: task.teamId, toKind: 'session', toId: outstanding.claimedBy,
        fromKind: 'human', fromSession: null, fromGroup: null,
        originPath: team.groupsRoot,
        priority: 'normal', taskId: task.id, actor: 'human',
        body: `Task ${task.title} was reassigned to ${targetLabel(target)}; your work is not cancelled — report status with a journal note if still relevant.`,
      })
    }
    this.store.supersede(outstanding.id, newId, nowIso())
    this.tasks.appendJournal(task.id, actor, `Assignment to ${targetLabel(previous)} superseded by ${supersededBy}`)
  }

  /**
   * Read-only dispatch preview (D6): the worktree the instruction would route
   * by, the role, the effective profile, the approval policy, and staffing
   * availability. Warns — never blocks — when a session target works outside
   * the task's worktree. Writes nothing and reserves nothing.
   */
  async preview(caller: TaskCaller, input: { taskId?: string; worktree?: string; target: AssignmentTarget; worker?: string }): Promise<TaskDispatchPreview> {
    refuseSystem(caller, 'read')
    const team = await this.teamOf(caller)
    let taskWorktree: string | null = null
    if (input.taskId) {
      const task = this.tasks.get(input.taskId)
      if (!task || task.teamId !== team.teamId) throw new Error(`Task not found in this team: ${input.taskId}`)
      taskWorktree = task.worktree
    } else if (input.worktree?.trim()) {
      const target = await this.options.worktrees.resolveTarget(team.teamId, input.worktree.trim())
      if (!target.ok) throw new Error(target.error)
      taskWorktree = target.root
    }
    // The worker choice is checked as dispatch checks it: a session target or a bad worker is refused.
    const workerChoice = this.workerChoice(caller, team, input.target, input.worker)
    if (input.target.kind === 'group') {
      const group = this.groupOf(team, input.target.id)
      return await this.previewGroup(team, taskWorktree, input.target, group, workerChoice)
    }
    const recipient = await this.sessionTarget(team, input.target)
    if (!recipient) throw new Error(`Unknown session: ${input.target.id}`)
    return this.previewSession(taskWorktree, input.target, recipient)
  }

  private async previewGroup(team: TeamIdentity, worktree: string | null, target: AssignmentTarget, group: GroupDefinition, workerChoice: string | null): Promise<TaskDispatchPreview> {
    return previewGroupDispatch({
      worktree, target, group, workerChoice,
      members: liveGroupMembers(this.options.records(), id => this.options.teamOf(id)?.teamId, team.teamId, target.id),
      recipient: id => this.options.recipient?.(id),
      facts: this.options.staffing.preview(team.teamId, target.id, worktree),
      teamCap: await this.options.caps.maxSpawnedSessions(team.teamId),
      providerOf: ambientProviderOf(this.options.homeDir),
      cooldownUntil: profileId => this.options.cooldownUntil?.(profileId) ?? null,
      teamDefault: this.options.staffing.approvalDefaults.get(team.teamId),
      now: Date.now(),
    })
  }

  private previewSession(worktree: string | null, target: AssignmentTarget, recipient: ChatSessionRecord): TaskDispatchPreview {
    const sessionWorktree = worktreeRootOf(recipient.projectPath)
    return {
      worktree, target, role: null,
      profile: recipient.claudeProfileId ?? 'default', approval: recipient.approvalPolicy ?? 'manual',
      sessionWorktree, idleMembers: [],
      spawn: { allowed: false, profile: null, blockedBy: 'the assignment names an existing session' },
      warning: worktree !== null && sessionWorktree !== worktree
        ? `Session works in ${sessionWorktree}; the task targets ${worktree}`
        : null,
    }
  }

  /**
   * The pickers' data (D8): worktrees of the team's repository with their
   * branches, and the active OpenSpec changes found under exactly the roots
   * `validateChange` accepts — the main checkout root plus, when a worktree
   * is chosen, that worktree — so a listed choice always validates. The
   * worktree list itself stays team-wide. `archive` is excluded.
   */
  async targets(caller: TaskCaller, worktree?: string): Promise<TaskTargetOptions> {
    refuseSystem(caller, 'read')
    const team = await this.teamOf(caller)
    const worktrees = await this.options.worktrees.entries(team.teamId)
    let chosen: string | null = null
    if (worktree?.trim()) {
      const target = await this.options.worktrees.resolveTarget(team.teamId, worktree.trim())
      if (!target.ok) throw new Error(target.error)
      chosen = target.root
    }
    const roots = [team.groupsRoot, ...(chosen ? [chosen] : [])]
    const changes = new Map<string, string[]>()
    for (const root of roots) {
      let names: string[]
      try {
        names = fs.readdirSync(path.join(root, 'openspec', 'changes'))
      } catch { continue }
      for (const name of names) {
        if (!CHANGE_NAME.test(name) || name === 'archive') continue
        try {
          if (!fs.statSync(path.join(root, 'openspec', 'changes', name)).isDirectory()) continue
        } catch { continue }
        changes.set(name, [...(changes.get(name) ?? []), root])
      }
    }
    return {
      worktrees,
      changes: [...changes.entries()].map(([name, locations]) => ({ name, locations })).sort((a, b) => a.name.localeCompare(b.name)),
      plans: this.planTargets(team.teamId),
    }
  }

  /** Open plans with an approved revision, and the change names a task may link to (durable-plans D9). */
  private planTargets(teamId: string): NonNullable<TaskTargetOptions['plans']> {
    const plans = this.options.plans
    if (!plans) return []
    return plans.openPlans(teamId).flatMap(plan => {
      const approved = plans.approvedRevision(plan.id)
      return approved ? [{ id: plan.id, title: plan.title, revision: approved.revision, changes: approved.content.changes.map(change => change.change) }] : []
    })
  }

  /**
   * The dispatch's creator and mail sender (plan-execution D2): one arm per
   * caller kind, so Kawai is never recorded as the human. Kawai's mail has no
   * sender session or group and originates at the team's main checkout.
   */
  private dispatcher(caller: TaskCaller, team: TeamIdentity): {
    creator: TaskCreator
    sender: { fromKind: TaskCreator['kind']; fromSession: string | null; fromGroup: string | null; originPath: string; actor?: 'system' | 'human' }
  } {
    switch (caller.kind) {
      case 'agent': {
        const session = this.options.getSession(caller.sessionId)
        if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
        return {
          creator: { kind: 'agent', sessionId: session.sessionId },
          sender: { fromKind: 'agent', fromSession: session.sessionId, fromGroup: session.groupId ?? null, originPath: session.projectPath },
        }
      }
      case 'human':
        return {
          creator: { kind: 'human', sessionId: null },
          sender: { fromKind: 'human', fromSession: null, fromGroup: null, originPath: team.groupsRoot, actor: 'human' },
        }
      case 'system':
        return {
          creator: { kind: 'system', sessionId: null },
          sender: { fromKind: 'system', fromSession: null, fromGroup: null, originPath: team.groupsRoot, actor: 'system' },
        }
      default: {
        const never: never = caller
        throw new Error(`Unknown caller: ${JSON.stringify(never)}`)
      }
    }
  }

  /** The caller's team: the human and Kawai carry it; an agent resolves from its session. */
  private async teamOf(caller: TaskCaller): Promise<TeamIdentity> {
    if (caller.kind !== 'agent') return caller.team
    const session = this.options.getSession(caller.sessionId)
    if (!session) throw new Error(`Unknown calling session: ${caller.sessionId}`)
    return resolveTeam(session.projectPath)
  }

  private groupOf(team: TeamIdentity, id: string): GroupDefinition {
    const catalog = loadGroupCatalog({ groupsRoot: team.groupsRoot, ...(this.options.homeDir ? { homeDir: this.options.homeDir } : {}) })
    const group = catalog.groups.get(id)?.group
    if (!group) throw new Error(`Unknown group: ${id}`)
    return group
  }

  /**
   * A live same-team session target, or null for group targets. Refuses an
   * unknown, archived, other-team, or context-exhausted session before
   * anything is written. The flag is read after the last await, so nothing
   * can flag the session between this check and the dispatch's commit
   * (chat-context-exhaustion D5: its instruction would never deliver).
   */
  private async sessionTarget(team: TeamIdentity, target: AssignmentTarget): Promise<ChatSessionRecord | null> {
    if (target.kind !== 'session') return null
    const found = this.options.getSession(target.id)
    if (!found) throw new Error(`Unknown session: ${target.id}`)
    if (found.archivedAt != null) throw new Error(`Session ${target.id} is archived`)
    if ((await resolveTeam(found.projectPath)).teamId !== team.teamId) throw new Error(`Session ${target.id} belongs to another team`)
    const recipient = this.options.getSession(target.id)
    if (!recipient) throw new Error(`Unknown session: ${target.id}`)
    if (recipient.archivedAt != null) throw new Error(`Session ${target.id} is archived`)
    const flag = recipient.contextExhausted
    if (flag) {
      throw new Error(`Session ${target.id}'s context is exhausted (${flag.reason}, since ${flag.at}); it takes no mail until ` +
        '/compact or a successful turn clears it. Assign the task to a group or another session. Nothing was written.')
    }
    return recipient
  }

  /** Which normalized request field differs between a stored dispatch and a replayed intent (D4). */
  private payloadDiff(existing: TeamTaskAssignment, taskId: string,
    input: { target: AssignmentTarget; instruction: string; workerChoice: string | null; handoff: DispatchHandoff | null }): string | null {
    if (existing.taskId !== taskId) return 'task'
    if (existing.targetKind !== input.target.kind || existing.targetId !== input.target.id) return 'target'
    if (existing.instruction !== input.instruction.trim()) return 'instruction'
    // Compared normalized (D7): a bare model key and its provider/model form are one payload.
    if ((existing.workerChoice ?? null) !== input.workerChoice) return 'worker'
    // Handoff identity (task-results-handoffs D3): a replay carrying another result is refused.
    return handoffDiff(existing, input.handoff)
  }
}
