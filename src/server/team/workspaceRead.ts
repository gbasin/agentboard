// The team workspace's read model (team-workspace design D1): task rows,
// attention items, member rows, and the morning summary, projected from the
// stores that already own the facts — TaskStore summaries, the mailbox, the
// waiting-reason ledger, chat session records, and the group catalog. The
// workspace owns no tables; every function here is a pure projection, so the
// connection layer can recompute on the same triggers the mailbox and task
// views already use and diff before pushing.
import type { ChatApprovalPolicy, ChatPendingRequest } from '../../shared/chat'
import { resolveSpawnApproval } from '../../shared/spawnApproval'
import type {
  AttentionItem,
  TeamMemberRow,
  TeamMemberSession,
  TaskAcknowledgementBadge,
  TeamTaskRow,
  TeamWorkspaceSnapshot,
} from '../../shared/teamWorkspace'
import { attentionItemId } from '../../shared/teamWorkspace'
import type { OutboundViolationGroup } from '../outbound/service'
import { outboundAttentionItems } from './workspaceOutbound'
import { teamTaskStage } from '../../shared/teamTaskStage'
import type { TeamMessage, WaitingConstraint, WaitingReason } from '../../shared/team'
import type { TeamTaskSummary } from '../../shared/teamTasks'
import type { ChatSessionRecord } from '../db'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { acceptanceItems, taskImpact, type PendingAcceptance } from './attentionAcceptance'
import { exhaustionAttentionItems, type ExhaustionFact } from './workspaceExhaustion'
import { CAPACITY_CONSTRAINT_KINDS, capacityConstraintLabel, morningSummary } from './workspaceSummary'
import {
  decisionQuestionItems, planConditionItems, planFixItems, planPromotionItems, planStallItems, planStopItems,
  type PlanAttentionFact, type PlanSummaryRows,
} from './planAttention'
import type { GroupCatalog } from './groupCatalog'
import type { TeamIdentity } from './teamIdentity'

/** The provider holding the model, for the Members tab's grouping (D13). */
function providerLabelOf(catalog: GroupCatalog, profileId: string): { id: string; label: string } | undefined {
  for (const [id, provider] of catalog.providers) {
    if (provider.models.includes(profileId)) return { id, label: provider.label }
  }
  return undefined
}

/**
 * Members (task 2.2): one read-only row per group of the catalog — the role
 * description, never the prompt body (D7, Q3); every effective setting; each
 * layer's source file with the winner marked (2.1); and the live membership
 * with per-profile caps and live counts. Nothing here writes: prompt changes
 * affect future agent starts only.
 */
export function memberRows(
  catalog: GroupCatalog,
  records: ChatSessionRecord[],
  countsOf: (groupId: string) => Record<string, number>,
  teamDefault: ChatApprovalPolicy | null = null,
): TeamMemberRow[] {
  return [...catalog.groups.values()].map(({ group, sources }) => {
    const live = countsOf(group.id)
    // The spawn's own resolution (team-approval-default D2), never a copy of the group key.
    const approval = resolveSpawnApproval(group.approval, teamDefault)
    const members: TeamMemberSession[] = records
      .filter(record => record.archivedAt == null && record.groupId === group.id)
      .map(record => ({
        sessionId: record.sessionId,
        name: record.name,
        spawned: record.spawned === true,
        profile: record.claudeProfileId ?? 'default',
        status: record.status,
        taskId: record.taskId ?? null,
      }))
    return {
      id: group.id,
      label: group.label,
      description: group.description,
      canCreateTasks: group.canCreateTasks,
      max: group.max,
      profiles: group.profiles.map(entry => {
        const provider = providerLabelOf(catalog, entry.profileId)
        return {
          profileId: entry.profileId,
          providerId: provider?.id ?? entry.profileId,
          providerLabel: provider?.label ?? entry.profileId,
          live: live[entry.profileId] ?? 0,
          ...(entry.cap !== undefined ? { cap: entry.cap } : {}),
        }
      }),
      approval: approval.policy,
      approvalSource: approval.source,
      strategy: group.strategy,
      onLimit: group.onLimit.forwardTo !== undefined
        ? { parkIfResetWithinMs: group.onLimit.parkIfResetWithinMs, otherwise: group.onLimit.otherwise, forwardTo: group.onLimit.forwardTo }
        : { parkIfResetWithinMs: group.onLimit.parkIfResetWithinMs, otherwise: group.onLimit.otherwise },
      ...(group.effort !== undefined ? { effort: group.effort } : {}),
      ...(group.profileEffort !== undefined ? { profileEffort: { ...group.profileEffort } } : {}),
      warnings: [...group.warnings],
      sources: sources.map(({ file, layer, inEffect }) => ({ file, layer, inEffect })),
      members,
    }
  })
}

/**
 * Awaiting acknowledgement (task-revision-publication D5): the outstanding
 * claimant of a live task has acknowledged an older revision than the
 * current one. Delivery and acknowledgement stay two facts. Closed tasks and
 * unclaimed assignments (nobody to acknowledge) show no badge.
 */
function acknowledgementBadge(
  summary: TeamTaskSummary,
  revisionsOf: (taskId: string, sessionId: string) => { delivered: number | null; acknowledged: number | null },
): TaskAcknowledgementBadge | null {
  const claimant = summary.assignment?.claimedBy
  if (!claimant || summary.status === 'done' || summary.status === 'cancelled') return null
  const { delivered, acknowledged } = revisionsOf(summary.id, claimant)
  if ((acknowledged ?? 0) >= summary.revision) return null
  return { revision: summary.revision, deliveredRevision: delivered, acknowledgedRevision: acknowledged }
}

/** D11's next action for a row, derived from the assignment and result it already read. */
function taskNextAction(summary: TeamTaskSummary, ownedByExecution: boolean): string {
  const assignment = summary.assignment
  if (summary.outstandingResult && !summary.outstandingResult.accepted && summary.status !== 'done' && summary.status !== 'cancelled') {
    if (summary.outstandingResult.reviewVerdict === 'fail') return 'Wait for fixes'
    return ownedByExecution ? 'Wait for Kawai' : 'Accept result'
  }
  if (!assignment) return 'Assign a dev'
  switch (assignment.state) {
    case 'queued': return 'Wait for capacity'
    case 'uncertain': return 'Retry or discard'
    default: return 'Wait for agent'
  }
}

/**
 * Task rows (task 3.2): title, status, D4's stage, the accountable session or
 * requested role, worktree, the instruction mail's waiting reason, and the
 * next action. A group assignment still queued names the requested role and
 * no session (the spec's fallback); a claimed one names the claimant.
 * `requiresHuman` marks rows some human-required attention item blocks, which
 * is what the awaiting-human filter keeps.
 */
export function taskRows(input: {
  summaries: TeamTaskSummary[]
  waiting: Record<string, WaitingReason>
  attention: AttentionItem[]
  nameOf: (sessionId: string) => string
  /** A claimant's delivered and acknowledged revisions of a task (task-revision-publication D5). */
  revisionsOf: (taskId: string, sessionId: string) => { delivered: number | null; acknowledged: number | null }
  /** A running execution owns the task, so Kawai, not the human, accepts its result. */
  ownedByExecution?: (taskId: string) => boolean
}): TeamTaskRow[] {
  const { summaries, waiting, attention, nameOf, revisionsOf, ownedByExecution } = input
  const humanBlocked = new Set(
    attention.filter(item => item.requiresHuman && item.impact.taskId).map(item => item.impact.taskId!)
  )
  return summaries.map(summary => {
    const assignment = summary.assignment
    const accountable = !assignment ? null
      : assignment.claimedBy ? { kind: 'session' as const, id: assignment.claimedBy, label: nameOf(assignment.claimedBy) }
      : assignment.targetKind === 'group'
        ? { kind: 'group' as const, id: assignment.targetId, label: assignment.role ?? assignment.targetId }
        : { kind: 'session' as const, id: assignment.targetId, label: nameOf(assignment.targetId) }
    const result = summary.outstandingResult ?? null
    return {
      id: summary.id,
      title: summary.title,
      status: summary.status,
      stage: teamTaskStage(summary, assignment, result),
      accountable,
      groupId: assignment?.targetKind === 'group' ? assignment.targetId : null,
      worktree: summary.worktree,
      waitingReason: assignment?.messageId ? waiting[assignment.messageId] ?? null : null,
      needsReevaluation: result?.needsReevaluation === true,
      acknowledgement: acknowledgementBadge(summary, revisionsOf),
      nextAction: taskNextAction(summary, ownedByExecution?.(summary.id) === true),
      requiresHuman: humanBlocked.has(summary.id),
    }
  })
}

/** What one attention source reads (D5): pure facts, no manager references. */
export interface AttentionInput {
  /** Live sessions of the team with their pending requests. */
  sessions: Array<{ record: ChatSessionRecord; requests: ChatPendingRequest[] }>
  /** The team's unsettled mail (the mailbox view's own set). */
  messages: TeamMessage[]
  /** The waiting-reason ledger's current entries, keyed by message id. */
  waiting: Record<string, WaitingReason>
  taskTitle: (taskId: string) => string | null
  nameOf: (sessionId: string) => string
  /** Open tasks whose outstanding result awaits **Accept result**. */
  pendingAcceptance: PendingAcceptance[]
  /** The team's unacknowledged violations, grouped by rule and destination (execution-safety-recovery D10). */
  outboundViolations: OutboundViolationGroup[]
  /** Recorded context-exhaustion episodes with their resolution facts (chat-context-exhaustion D8). */
  exhaustion?: ExhaustionFact[]
  /** Each open plan's attention facts, gathered once per snapshot (plan-supervision D13). */
  plans?: PlanAttentionFact[]
}

/** One attention source: a pure function over the input (D5's registry). */
export type AttentionSource = (input: AttentionInput) => AttentionItem[]

/** Pending approvals and questions of the team's live sessions (E05). */
const requestItems: AttentionSource = ({ sessions, taskTitle }) =>
  sessions.flatMap(({ record, requests }) =>
    requests.map(request => {
      const kind = request.kind === 'approval' ? 'approval' : 'question'
      const cause = request.kind === 'approval'
        ? `Approval requested: ${request.tool}`
        : `Question asked: ${request.questions[0]?.question ?? 'the agent needs an answer'}`
      return {
        id: attentionItemId(kind, `${record.sessionId}:${request.requestId}`),
        kind,
        cause,
        owner: { kind: 'session' as const, id: record.sessionId, label: record.name },
        impact: taskImpact(record.taskId ?? null, taskTitle),
        nextAction: request.kind === 'approval' ? 'Answer approval' : 'Answer question',
        link: { kind: 'chat' as const, id: record.sessionId },
        requiresHuman: true,
      }
    })
  )

/** Messages held as uncertain deliveries: only the human can retry or discard. */
const uncertainItems: AttentionSource = ({ messages, taskTitle, nameOf }) =>
  messages
    .filter(message => message.state === 'uncertain')
    .map(message => {
      return {
        id: attentionItemId('uncertain-delivery', message.id),
        kind: 'uncertain-delivery' as const,
        cause: `Delivery uncertain${message.reason ? `: ${message.reason}` : ''}`,
        owner: message.fromSession
          ? { kind: 'session' as const, id: message.fromSession, label: nameOf(message.fromSession) }
          : { kind: 'human' as const, id: null, label: 'Human' },
        impact: {
          ...taskImpact(message.taskId, taskTitle),
          ...(message.toKind === 'group' && message.toId ? { groupId: message.toId } : {}),
        },
        nextAction: 'Retry or discard',
        link: { kind: 'message' as const, id: message.id },
        requiresHuman: true,
      }
    })

/** Mail waiting on capacity: agent-owned waits, not human blocking (E05). */
const staffingItems: AttentionSource = ({ messages, waiting, taskTitle, nameOf }) => {
  const byId = new Map(messages.map(message => [message.id, message]))
  return Object.entries(waiting)
    .filter(([, reason]) => CAPACITY_CONSTRAINT_KINDS.has(reason.blocker.kind))
    .flatMap(([messageId, reason]) => {
      const message = byId.get(messageId)
      if (!message) return []
      return [{
        id: attentionItemId('staffing-wait', messageId),
        kind: 'staffing-wait' as const,
        cause: capacityConstraintLabel(reason.blocker),
        owner: message.toKind === 'group' && message.toId
          ? { kind: 'group' as const, id: message.toId, label: message.toId }
          : { kind: 'session' as const, id: message.toId, label: message.toId ? nameOf(message.toId) : '' },
        impact: taskImpact(message.taskId, taskTitle),
        nextAction: 'Wait for capacity',
        link: { kind: 'message' as const, id: messageId },
        requiresHuman: false,
      }]
    })
}

/** Unacknowledged outbound violations (execution-safety-recovery D10; workspaceOutbound.ts). */
const outboundItems: AttentionSource = ({ outboundViolations, nameOf }) => outboundAttentionItems(outboundViolations, nameOf)

/** Context-exhausted sessions awaiting a decision (chat-context-exhaustion D8; workspaceExhaustion.ts). */
const exhaustionItems: AttentionSource = ({ exhaustion, taskTitle, nameOf }) =>
  exhaustionAttentionItems(exhaustion ?? [], taskTitle, nameOf)

/**
 * The source registry (task 4.1; the plan sources join in plan-supervision
 * D13) — an item of an unrecognized kind is data like any other and never
 * dropped.
 */
export const ATTENTION_SOURCES: readonly AttentionSource[] = [
  requestItems, uncertainItems, staffingItems, acceptanceItems, outboundItems, exhaustionItems,
  planStopItems, planStallItems, decisionQuestionItems, planFixItems, planConditionItems, planPromotionItems,
]

/** Every attention item the current state yields, in a stable order. */
export function attentionItems(
  input: AttentionInput,
  sources: readonly AttentionSource[] = ATTENTION_SOURCES,
): AttentionItem[] {
  return sources.flatMap(source => source(input)).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * The manager-facing read: one snapshot over everything the pure projections
 * above need. Held by the connection layer, which recomputes on the triggers
 * the mailbox and task views already use. Turn ends come from the durable
 * `chat_turn_ends` table the manager's event path writes (D8) — no transcript
 * is replayed here.
 */
export class WorkspaceRead {
  constructor(private readonly manager: ChatSessionManager) {}

  snapshot(team: TeamIdentity): TeamWorkspaceSnapshot {
    const manager = this.manager
    const teamId = team.teamId
    const store = manager.tasks.store
    const summaries = store.list(teamId)
    const messages = manager.mailbox.store.listForTeam(teamId)
    const waiting = manager.waitingFor(teamId)
    const records = manager.teamRecords(teamId)
    const directory = manager.directory.list(teamId)
    const approvalDefault = manager.teamApprovalDefault(teamId)
    const nameOf = (sessionId: string) =>
      records.find(record => record.sessionId === sessionId)?.name
      ?? directory.find(entry => entry.sessionId === sessionId)?.name
      ?? sessionId
    const taskTitle = (taskId: string) => store.get(taskId)?.title ?? null
    // The same naming TaskResultCard's actorLabel uses: "Human", or the session's name.
    const actorName = (actor: { sessionId: string | null }) => actor.sessionId === null ? 'Human' : nameOf(actor.sessionId)
    const sessions = records
      .filter(record => record.archivedAt == null)
      .map(record => ({ record, requests: manager.getPendingRequests(record.sessionId) }))
    // Kawai accepts an execution-owned task when its change lands. A human
    // accept would stop the change as task-closed, so it is never asked for.
    const ownedByExecution = (taskId: string) => manager.results?.ownedByExecution(taskId) === true
    const pendingAcceptance: PendingAcceptance[] = summaries.flatMap(summary => {
      const result = summary.outstandingResult
      if (!result || result.accepted || summary.status === 'done' || summary.status === 'cancelled') return []
      if (ownedByExecution(summary.id)) return []
      const submittedBy = store.results.get(result.id)?.submittedBy
      const creatorId = summary.creator.sessionId
      const creator = creatorId ? records.find(record => record.sessionId === creatorId && record.archivedAt == null) : undefined
      return [{
        resultId: result.id, taskId: summary.id, submitter: submittedBy ? actorName(submittedBy) : 'Human',
        submitterId: submittedBy?.sessionId ?? null, needsReevaluation: result.needsReevaluation,
        reviewVerdict: result.reviewVerdict, liveCreator: creator ? { sessionId: creator.sessionId, name: creator.name } : null,
      }]
    })
    const attention = attentionItems({
      sessions, messages, waiting, taskTitle, nameOf, pendingAcceptance,
      // The audit records' unacknowledged violations (execution-safety-recovery D10).
      outboundViolations: manager.outboundAudit.violationGroups(teamId),
      // The plan sources' facts, gathered over the supervision reads (plan-supervision D13).
      plans: manager.planAttentionFacts?.(teamId) ?? [],
      exhaustion: manager.exhaustionEpisodes(teamId).map(episode => {
        const record = records.find(row => row.sessionId === episode.sessionId)
        const task = episode.taskId ? store.get(episode.taskId) : null
        const dispatches = task ? store.assignmentsOf(task.id).map(row => row.createdAt).sort() : []
        return {
          episode,
          sessionName: record?.name ?? null,
          currentFlagAt: record?.contextExhausted?.at ?? null,
          droppedState: episode.droppedId ? manager.mailbox.store.get(episode.droppedId)?.state ?? null : null,
          taskStatus: task?.status ?? null,
          newestDispatchAt: dispatches.at(-1) ?? null,
        }
      }),
    })
    const now = new Date().toISOString()
    const since = new Date(Date.parse(now) - 24 * 60 * 60 * 1000).toISOString()
    const revisionsOf = (taskId: string, sessionId: string) => ({
      delivered: store.notices?.deliveredRevision(taskId, sessionId) ?? null,
      acknowledged: store.acknowledgements.highest(taskId, sessionId),
    })
    return {
      tasks: taskRows({ summaries, waiting, attention, nameOf, revisionsOf, ownedByExecution }),
      attention,
      members: memberRows(manager.teams.catalogForTeam(team), records, groupId =>
        manager.groupProfileCounts(teamId, groupId), approvalDefault),
      approvalDefault,
      summary: morningSummary({
        now,
        sessions,
        messages,
        messageEvents: messageId => manager.mailbox.store.eventsFor(messageId)
          .map(event => ({ kind: event.kind, createdAt: event.createdAt })),
        waiting,
        // The store's join keeps a killed agent's turns in the team's window
        // and reads only this team's rows; ok = 1 is built into the query.
        turnEnds: manager.turnEnds
          .finishedForTeam(teamId, since)
          .map(row => ({ sessionId: row.sessionId, taskId: row.taskId, at: row.endedAt })),
        nameOf,
        hasResult: (sessionId, taskId) => taskId !== null && store.results.submittedBy(taskId, sessionId),
        results: store.results.outstandingSince(teamId, since).map(result => ({
          resultId: result.id,
          taskId: result.taskId,
          taskTitle: taskTitle(result.taskId),
          submitter: actorName(result.submittedBy),
          accepted: result.acceptedAt !== null,
        })),
        outboundCounts: manager.outboundAudit.windowCounts(teamId, since, now),
        // The window's durable plan rows (plan-supervision D13).
        plans: manager.planSummaryRows?.(teamId, since) ?? {
          landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [],
        },
      }),
      directory,
    }
  }
}
