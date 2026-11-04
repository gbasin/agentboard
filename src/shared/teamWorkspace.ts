// SDK-free team workspace read model (team-workspace design D1/D4/D5/D7/D8),
// shared by the server's projections and the client's Team page. The
// workspace owns no tables: every type here is a display-shaped projection of
// facts other stores own, so nothing in this file is persisted or sequenced.
import type { SessionDirectoryEntry, WaitingReason } from './team'
import type { TaskStatus } from './teamTasks'

/**
 * What an attention item is about (D5). The Phase 1 registry produces
 * approvals, questions, uncertain deliveries, and staffing waits;
 * `pending-acceptance` joins with `task-results-handoffs`, and
 * `fixes-requested` (a failing review awaiting its submitter's fixes) with
 * `attention-acceptance-ownership`. The plan-supervision kinds
 * (plan-supervision D13) cover the plan sources: a stopped change, a stall,
 * an open decision card, an open fix or correction task, an acceptance
 * condition, and a failed promotion. The type stays open to plain strings so
 * an unrecognized kind renders instead of being dropped.
 */
export type AttentionKind =
  | 'approval'
  | 'question'
  | 'uncertain-delivery'
  | 'staffing-wait'
  | 'pending-acceptance'
  | 'fixes-requested'
  // The owner's informational item for unacknowledged outbound violations
  // (execution-safety-recovery D10): nothing waits on it, only the human
  // clears it, and it never stops execution, supervision, or dispatch.
  | 'outbound-violation'
  // The plan sources (plan-supervision D13), each raised by one source in
  // the server's `planAttention.ts` and cleared when its cause clears.
  | 'plan-stop'
  | 'plan-stall'
  | 'decision-question'
  | 'plan-fix'
  | 'plan-condition'
  | 'plan-promotion'
  | (string & {})

/** Who an attention item is waiting on: the human, one session, or a group. */
export interface AttentionOwner {
  kind: 'human' | 'session' | 'group'
  /** Null for the human; a group id otherwise. */
  id: string | null
  label: string
}

/** Where an attention item's consequence lands; every field optional. */
export interface AttentionImpact {
  taskId?: string
  taskTitle?: string
  worktree?: string
  groupId?: string
}

/**
 * D11: a link names where the existing human action lives — never a new one.
 * `plan` (plan-supervision D13) is the Plans tab's plan detail, named by
 * `planId`; `change` scopes it to one change when the item has one. A `card`
 * link is a decision card and carries its `planId`.
 */
export interface AttentionLink {
  kind: 'card' | 'task' | 'message' | 'chat'
  /** `audit` (execution-safety-recovery D10): the Audit tab, `id` a call id or '' for the tab. */
  | 'audit'
  /** `plan` (plan-supervision D13): the plan detail; `id` is the plan id. */
  | 'plan'
  id: string
  /** The plan a `plan` or `card` link opens. */
  planId?: string
  /** The change of the plan the link scrolls to, when the item has one. */
  change?: string
}

export interface AttentionItem {
  /**
   * `${kind}:${sourceId}` (D5): stable across reconnects, so toasts and
   * counts key on it. Source ids are unique per store (request id, message
   * id, task id); a collision is a bug in a source, not queue behaviour.
   */
  id: string
  kind: AttentionKind
  /** One line, from the source's own facts. */
  cause: string
  owner: AttentionOwner
  impact: AttentionImpact
  /** Verb phrase naming what to do ("Answer approval", "Retry or discard"). */
  nextAction: string
  link: AttentionLink
  /** True when only the human can move it; false for agent-owned waits. */
  requiresHuman: boolean
}

/** The item identity D5 defines: kind-prefixed, stable across reconnects. */
export const attentionItemId = (kind: AttentionKind, sourceId: string): string => `${kind}:${sourceId}`

/**
 * D4's workflow stage, projected — never stored: handoff stages
 * (`in-review`, `ready-for-qa`, `fixes-requested`), then
 * `awaiting-acceptance`, then the assignment's own `implementing` /
 * `unstarted`; closed tasks have none. The stage is never `done`: a finished
 * agent turn never moves it.
 */
export type TeamTaskStage =
  | 'in-review'
  | 'ready-for-qa'
  | 'fixes-requested'
  | 'awaiting-acceptance'
  | 'implementing'
  | 'unstarted'

/** The accountable party of a task row: a session, the requested role, or none yet. */
export interface TaskAccountable {
  kind: 'session' | 'group' | 'human'
  id: string | null
  label: string
}

/**
 * "Delivered rev 2 · Acknowledged rev 1" (task-revision-publication D5): the
 * outstanding claimant has not acknowledged the task's current revision. The
 * delivered and acknowledged revisions stay separate facts; null = none yet.
 */
export interface TaskAcknowledgementBadge {
  /** The task's current revision. */
  revision: number
  deliveredRevision: number | null
  acknowledgedRevision: number | null
}

export interface TeamTaskRow {
  id: string
  title: string
  status: TaskStatus
  /** D4's projection; null when the task is done or cancelled. */
  stage: TeamTaskStage | null
  /** The claimed session, else the requested role; null when unassigned. */
  accountable: TaskAccountable | null
  /** The assignment's target group (the requested role); null when none. */
  groupId: string | null
  worktree: string | null
  /**
   * The instruction mail's current waiting reason, structured so the client
   * labels it with the same helper the mailbox uses; null when none applies.
   */
  waitingReason: WaitingReason | null
  /** Badge (D4): the outstanding result predates the task's current revision. */
  needsReevaluation: boolean
  /** Badge (D4): set while the outstanding claimant lacks the current revision's acknowledgement. */
  acknowledgement: TaskAcknowledgementBadge | null
  /** D11 verb phrase; null when no next action is derivable. */
  nextAction: string | null
  /** Whether some human-required attention item blocks this task. */
  requiresHuman: boolean
}

/**
 * The task list's filters (team-workspace spec): every field optional, absent
 * keeps everything — except that done/cancelled tasks stay out of the default
 * list. `search` is the one way closed tasks surface: it matches them like
 * any other row. Pure so the client store and tests share one definition.
 */
export interface TeamTaskRowQuery {
  /** Keep only this task status. */
  status?: TaskStatus
  /** Only rows whose next action requires a human. */
  awaitingHuman?: boolean
  /** Only rows at D4's `awaiting-acceptance` stage (a Phase 2 source). */
  awaitingAcceptance?: boolean
  /** Only rows dispatched to this group (the requested role). */
  groupId?: string
  /** Only rows targeting this worktree root; null = only rows without one. */
  worktree?: string | null
  /** Case-insensitive substring over the title. */
  search?: string
  /**
   * Keep done/cancelled rows in the list. A host that searches more than the
   * title (the Tasks tab matches direction too) sets it while its own search
   * is active, so closed tasks stay searchable there as well.
   */
  includeClosed?: boolean
}

/** Apply the task list's filters, including the closed-task default. */
export function filterTeamTaskRows(rows: TeamTaskRow[], query: TeamTaskRowQuery = {}): TeamTaskRow[] {
  const search = query.search?.trim().toLowerCase()
  return rows.filter(row => {
    if (search && !row.title.toLowerCase().includes(search)) return false
    // Closed tasks stay searchable but sit outside the default list; an
    // explicit status filter for their own status also surfaces them.
    const closed = row.status === 'done' || row.status === 'cancelled'
    if (closed && !search && !query.includeClosed && query.status !== row.status) return false
    if (query.status && row.status !== query.status) return false
    if (query.awaitingHuman && !row.requiresHuman) return false
    if (query.awaitingAcceptance && row.stage !== 'awaiting-acceptance') return false
    if (query.groupId && row.groupId !== query.groupId) return false
    if (query.worktree !== undefined && (row.worktree ?? null) !== query.worktree) return false
    return true
  })
}

/** One live member of a group, as Members lists it (task 2.2). */
export interface TeamMemberSession {
  sessionId: string
  name: string
  /** Created by worktree staffing rather than by the human. */
  spawned: boolean
  profile: string
  status: string
  taskId: string | null
}

/** An allowed profile of a group with its cap and live count (spec: "1 of 2"). */
export interface TeamMemberProfile {
  profileId: string
  /** The provider owning this model (design D13): the Members tab groups by it. */
  providerId: string
  providerLabel: string
  /** Live-member cap (map form only); absent = uncapped. */
  cap?: number
  live: number
}

/** One layer's file for a group id, with the winner marked (D7). */
export interface TeamGroupSource {
  file: string
  layer: 'user' | 'project'
  /** Whether this layer's definition is the one in effect. */
  inEffect: boolean
}

/**
 * Members is a read-only inspection (spec): every field is a fact read from
 * the group's file or the live session set. Nothing here writes.
 */
export interface TeamMemberRow {
  id: string
  label: string
  /** The one-line role description; never the prompt body (D7, Q3). */
  description: string
  canCreateTasks: boolean
  /** Live-member cap for staffing spawns. */
  max: number
  /** Effective profiles with caps and live counts. */
  profiles: TeamMemberProfile[]
  /** The policy a spawned member gets, resolved with the team default (team-approval-default D2). */
  approval: 'manual' | 'auto'
  /** Where `approval` came from: the group file, the team default, or built-in manual. */
  approvalSource: 'group' | 'team' | 'built-in'
  strategy: string
  onLimit: { parkIfResetWithinMs: number; otherwise: 'forward' | 'release'; forwardTo?: string }
  /** Unset = Claude Code settings decide (group effort). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Valid per-profile overrides of `effort` (group-profile-effort); absent when none. */
  profileEffort?: Record<string, 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
  /** Problems that fell back to defaults, naming what fell back. */
  warnings: string[]
  /** Every layer's file for this group; exactly one is in effect. */
  sources: TeamGroupSource[]
  members: TeamMemberSession[]
}

/** One item of a summary bucket, with a link to where its action lives. */
export interface SummaryItem {
  id: string
  label: string
  link: AttentionLink
}

export interface SummaryBucket {
  items: SummaryItem[]
  /**
   * True when the bucket reads runtime state that a restart drops (D8):
   * capacity waits list only waits the running server has observed.
   */
  runtimeOnly?: boolean
}

/**
 * The morning summary's 24-hour window (D8, Q1/Q9): a rolling window ending
 * at read time, recomputed while the workspace is open. A finished turn with
 * no submitted result never lands in a completion bucket (E13). The five
 * plan buckets (plan-supervision D13) read durable rows only — a restart
 * never empties them.
 */
export interface MorningSummary {
  /** Window start (read time minus 24 h), ISO. */
  since: string
  /**
   * Outstanding results submitted in the window, each stating whether it was
   * accepted (D8, Q5): a submitted result is completed work, not accepted work.
   */
  completedResults: SummaryBucket
  capacityWaits: SummaryBucket
  approvals: SummaryBucket
  uncertainDeliveries: SummaryBucket
  finishedTurnsWithoutResult: SummaryBucket
  /**
   * The window's recorded outbound sends (execution-safety-recovery D10):
   * violations, unknown destinations, and allowed sends as row counts, read
   * from the durable audit records — a restart never empties it.
   */
  outbound: SummaryBucket
  /** Landing facts by landed_at (plan-supervision D13). */
  landings: SummaryBucket
  /** Change rows stopped, by updated_at (plan-supervision D13). */
  stops: SummaryBucket
  /** Stall-alert rows by raised_at (plan-supervision D13). */
  stallAlerts: SummaryBucket
  /** Recorded decisions of kind answer or own-call (plan-supervision D13). */
  decisions: SummaryBucket
  /** Recorded decisions of kind override (plan-supervision D13). */
  overrides: SummaryBucket
}

/** What `team-workspace-open` answers and every change push replaces (D1). */
export interface TeamWorkspaceSnapshot {
  tasks: TeamTaskRow[]
  attention: AttentionItem[]
  members: TeamMemberRow[]
  /** The team's default approval policy for spawned members; null = not set (team-approval-default D4). */
  approvalDefault: 'manual' | 'auto' | null
  summary: MorningSummary
  /** Last known identity of killed sessions named by rows and items. */
  directory: SessionDirectoryEntry[]
}
