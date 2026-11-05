// Team task subscriptions and human task actions (team-tasks 6.1/6.2). Like
// the mailbox view, every request names the team's directory (`teamPath`,
// team-workspace-pages D1); its resolved team scopes what may be seen or
// changed, so a task of another team is refused and an unknown path too.
// Snapshots are authoritative and re-sent whole on every change of the
// team's tasks (and of task mail), so a reconnecting client needs no deltas.
// Human actions run through TaskService as the human caller and answer with
// `team-task-result`; the changes they cause reach every subscriber. Direction
// changes go through a draft and a keyed publication (task-revision-publication
// D1/D2) — there is no direct amend from the UI.
import type { ClientMessage } from '../../shared/types'
import { unknownTeamError } from '../../shared/team'
import type { TeamTask } from '../../shared/teamTasks'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import type { ChatConnection } from '../chat/ChatConnections'

type TaskClientMessage = Extract<ClientMessage, { type: `team-task${string}` }>

interface Subscription {
  teamId: string
  list: boolean
  details: Set<string>
}

export class TaskConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, Subscription>>()
  /**
   * Latest open/close per connection and subscription target — a team's
   * list, or one task detail of it. Only a later open/close of the same
   * target supersedes a pending open: the list and a detail opened together
   * (header link, reconnect) must both stand.
   */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()

  constructor(private readonly manager: ChatSessionManager) {}

  disconnect(connection: ChatConnection) {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
  }

  publish(teamId: string) {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        if (subscription.teamId === teamId) this.send(connection, teamPath, subscription)
      }
    }
  }

  private send(connection: ChatConnection, teamPath: string, subscription: Subscription, only?: string) {
    const store = this.manager.tasks.store
    if (subscription.list && !only) {
      connection.send({ type: 'team-tasks-snapshot', teamPath, teamId: subscription.teamId, tasks: store.list(subscription.teamId) })
    }
    for (const taskId of subscription.details) {
      if (only && taskId !== only) continue
      // The human's view carries the task's draft (task-revision-publication D1)
      // and the release confirmation's data (task-results-handoffs D7).
      const human = store.humanDetail(taskId)
      const release = human ? this.manager.results?.release?.preview(taskId) : undefined
      const executionOwned = this.manager.results?.ownedByExecution(taskId) === true
      const detail = human && { ...human, ...(release ? { release } : {}), ...(executionOwned ? { executionOwned } : {}) }
      if (detail) connection.send({
        type: 'team-task-detail', teamPath, teamId: subscription.teamId, detail,
        // Its messages name participants; the directory keeps a killed one's.
        directory: this.manager.directory.list(subscription.teamId),
      })
    }
  }

  async handle(connection: ChatConnection, message: TaskClientMessage) {
    if ('requestId' in message) return this.act(connection, message)
    // Opens and closes of one target order against each other: the latest
    // wins, even when an earlier open is still resolving its team.
    const { teamPath } = message
    const target = `${teamPath}\0${'taskId' in message ? message.taskId : ''}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (message.type === 'team-tasks-close' || message.type === 'team-task-close') {
      const views = this.subscriptions.get(connection)
      const subscription = views?.get(teamPath)
      if ('taskId' in message) subscription?.details.delete(message.taskId)
      else if (subscription) subscription.list = false
      if (subscription && !subscription.list && subscription.details.size === 0) views!.delete(teamPath)
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    const taskId = 'taskId' in message ? message.taskId : undefined
    if (taskId !== undefined && this.manager.tasks.store.get(taskId)?.teamId !== team.teamId) {
      connection.send({ type: 'error', message: 'Task does not belong to this team' })
      return
    }
    // Read the connection's map only now: concurrent opens each awaited the
    // team, and a map captured before that would overwrite the others'.
    const views = this.subscriptions.get(connection) ?? new Map<string, Subscription>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, list: false, details: new Set<string>() }
    if (taskId === undefined) subscription.list = true
    else subscription.details.add(taskId)
    views.set(teamPath, subscription)
    this.send(connection, teamPath, subscription, taskId)
  }

  /** A human task action, as the human caller for the addressed team. */
  private async act(connection: ChatConnection, message: Extract<TaskClientMessage, { requestId: string }>) {
    const { teamPath, requestId } = message
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (!team) {
      const error = unknownTeamError(teamPath)
      if (message.type === 'team-task-preview') connection.send({ type: 'team-task-preview-result', teamPath, requestId, error })
      else if (message.type === 'team-task-targets') connection.send({ type: 'team-task-targets-result', teamPath, requestId, error })
      else if (message.type === 'team-task-capacity') connection.send({ type: 'team-task-capacity-result', teamPath, requestId, error })
      else connection.send({ type: 'team-task-result', teamPath, requestId, error })
      return
    }
    const caller = { kind: 'human' as const, team }
    const tasks = this.manager.tasks
    const result = (payload: Record<string, unknown>) => connection.send({ type: 'team-task-result', teamPath, requestId, ...payload })
    let task: TeamTask | undefined
    try {
      switch (message.type) {
        case 'team-task-create':
          task = await tasks.create(caller, {
            title: message.title, direction: message.direction, acceptance: message.acceptance ?? null,
            parent_id: message.parentId || null, worktree: message.worktree || null, openspec_change: message.openspecChange || null,
            plan_id: message.planId || null, plan_change: message.planChange || null,
            ...(message.requestKey ? { requestKey: message.requestKey } : {}),
          })
          break
        case 'team-task-draft':
          // A draft refreshes the human's view through its own listener (D1).
          if (message.action === 'save') {
            await tasks.saveDraft(caller, message.taskId, {
              direction: message.direction ?? '', acceptance: message.acceptance ?? null, rationale: message.rationale ?? null,
              ...(message.baseRevision !== undefined ? { baseRevision: message.baseRevision } : {}),
            })
          } else if (message.action === 'rebase') await tasks.rebaseDraft(caller, message.taskId)
          else await tasks.discardDraft(caller, message.taskId)
          task = tasks.store.get(message.taskId) ?? undefined
          break
        case 'team-task-publish': {
          // The human form requires a rationale (Q6); the store keeps it optional.
          if (!message.rationale.trim()) throw new Error('A publication needs a rationale')
          const outcome = await tasks.publish(caller, message.taskId, {
            direction: message.direction, acceptance: message.acceptance ?? null, rationale: message.rationale,
            baseRevision: message.baseRevision, requestKey: message.requestKey, notify: message.notify,
            ...(message.fromDraft ? { fromDraft: true } : {}),
          })
          result({ task: outcome.task, revision: outcome.revision.revision, replay: outcome.replay })
          return
        }
        case 'team-task-handoff': {
          const outcome = await this.manager.results.handoff(caller, message.taskId, {
            kind: message.kind, resultId: message.resultId, target: message.target, instructions: message.instructions,
            expectedResponse: message.expectedResponse ?? null, requestKey: message.requestKey,
            ...(message.worker !== undefined ? { worker: message.worker } : {}),
          })
          result({ assignment: outcome.assignment, replay: outcome.duplicate, task: tasks.store.get(message.taskId) ?? undefined })
          return
        }
        case 'team-task-release': {
          if (!this.manager.results.release) throw new Error('Release worktree and hand off is not available')
          const outcome = await this.manager.results.release.release(caller, message.taskId, {
            target: message.target, instructions: message.instructions, expectedResponse: message.expectedResponse ?? null,
            requestKey: message.requestKey, ...(message.worker !== undefined ? { worker: message.worker } : {}),
          })
          result({ assignment: outcome.handoff.assignment, replay: outcome.handoff.duplicate, task: tasks.store.get(message.taskId) ?? undefined })
          return
        }
        case 'team-task-accept-result':
          task = (await this.manager.results.accept(caller, message.taskId, message.resultId, message.reason)).task
          break
        case 'team-task-recheck':
          await this.manager.results.recheck(caller, message.taskId, message.resultId)
          task = tasks.store.get(message.taskId) ?? undefined
          break
        case 'team-task-notify': {
          const outcome = await tasks.notify(caller, message.taskId, message.revision, message.requestKey)
          result({ task: outcome.task, replay: outcome.replay })
          return
        }
        case 'team-task-note':
          await tasks.note(caller, message.taskId, message.text)
          task = tasks.store.get(message.taskId) ?? undefined
          break
        case 'team-task-status':
          task = await tasks.setStatus(caller, message.taskId, message.status)
          break
        case 'team-task-assign': {
          const outcome = await this.manager.assignments.dispatch(caller, {
            taskId: message.taskId, target: message.target, instruction: message.instruction,
            requestKey: message.requestKey, ...(message.handling ? { handling: message.handling } : {}),
            ...(message.worker !== undefined ? { worker: message.worker } : {}),
          })
          result({ assignment: outcome.assignment, ...(outcome.message?.taskId ? { task: tasks.store.get(outcome.message.taskId) ?? undefined } : {}) })
          return
        }
        case 'team-task-preview': {
          const preview = await this.manager.assignments.preview(caller, {
            ...(message.taskId ? { taskId: message.taskId } : {}),
            ...(message.worktree ? { worktree: message.worktree } : {}),
            target: message.target,
            ...(message.worker !== undefined ? { worker: message.worker } : {}),
          })
          connection.send({ type: 'team-task-preview-result', teamPath, requestId, preview })
          return
        }
        case 'team-task-targets': {
          const targets = await this.manager.assignments.targets(caller, message.worktree)
          connection.send({ type: 'team-task-targets-result', teamPath, requestId, targets })
          return
        }
        case 'team-task-capacity': {
          // The one TeamCapacity the `team_capacity` tool reads (D6): the
          // answer carries ids, counts, usage, and times only (I5).
          const capacity = this.manager.capacity.readTeam(team, this.manager.teams.catalogForTeam(team),
            message.group !== undefined ? { group: message.group } : {})
          connection.send({ type: 'team-task-capacity-result', teamPath, requestId, capacity })
          return
        }
      }
      result(task ? { task } : {})
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (message.type === 'team-task-preview') {
        connection.send({ type: 'team-task-preview-result', teamPath, requestId, error: text })
        return
      }
      if (message.type === 'team-task-targets') {
        connection.send({ type: 'team-task-targets-result', teamPath, requestId, error: text })
        return
      }
      if (message.type === 'team-task-capacity') {
        connection.send({ type: 'team-task-capacity-result', teamPath, requestId, error: text })
        return
      }
      result({ error: text })
    }
  }
}
