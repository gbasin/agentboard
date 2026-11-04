// SDK-free team task records (team-tasks design D1) shared by server and
// client views. A task's direction and acceptance criteria live in numbered,
// immutable revisions; `TeamTask` carries the latest one inline.
import type { ActingParty, TeamActor, TeamMessage } from './team'
import type { CitationOutcome, CoverageMap, MapComparison, ReviewerCoverageMap, WithheldCoverage } from './coverageMaps'

export type TaskStatus = 'open' | 'active' | 'blocked' | 'done' | 'cancelled'
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'active', 'blocked', 'done', 'cancelled']

/**
 * Who did something to a task: the human (through the UI) or an agent session.
 * An alias of the shared actor vocabulary (`TeamActor`), which message senders
 * use too — not of `TeamMessage['toKind']`'s routing vocabulary.
 */
export type TaskActor = TeamActor

/**
 * A journal entry's author: a team actor, or Kawai itself for actions the
 * system takes (member release, plan execution).
 */
export type JournalAuthor = ActingParty

/**
 * Who created a task or dispatched an assignment. plan-execution D2 reverses
 * member-release D4: Kawai (`system`) creates, dispatches, sends, hands off,
 * and accepts for a plan execution's tasks, as their creator, and so
 * authors their first revision. Every later revision's author is a
 * `TaskActor`: every human-only path (publish, notify, Release, plan and
 * strategy actions, validation decisions) still refuses `system`.
 */
export type TaskCreator = ActingParty

export interface TeamTask {
  id: string
  teamId: string
  title: string
  status: TaskStatus
  creator: TaskCreator
  parentId: string | null
  /** Target worktree root (normalized to `git worktree list`); null = none. */
  worktree: string | null
  /** Linked OpenSpec change name; null = none. */
  openspecChange: string | null
  /** The plan this task serves (durable-plans D9); fixed at creation, null = unlinked. */
  planId?: string | null
  /** The change of that plan; set exactly when `planId` is. */
  planChange?: string | null
  /** The linked plan's title, read with the task; null when unlinked. */
  planTitle?: string | null
  /** Latest revision number; starts at 1. */
  revision: number
  direction: string
  acceptance: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskRevision {
  revision: number
  direction: string
  acceptance: string | null
  /** Revision 1's author is the task's creator, so Kawai for an execution task. */
  author: TaskCreator
  createdAt: string
  /** Why it was published (task-revision-publication D2); null for agents without one and older rows. */
  rationale?: string | null
  /** Published with notices; null for rows published before notifications existed. */
  notify?: boolean | null
}

/**
 * The human's unpublished edit of a task's direction (task-revision-publication
 * D1): one per task, based on a named published revision. Never a revision,
 * never shown to agents, never mailed.
 */
export interface TaskDraft {
  taskId: string
  /** The published revision this draft edits. */
  baseRevision: number
  direction: string
  acceptance: string | null
  rationale: string | null
  updatedAt: string
}

/** The revision a notice announces (D3), carried on its mail row and envelope. */
export interface RevisionNotice {
  revision: number
  previousRevision: number
  assignmentId: string
  rationale: string | null
}

/** A recipient's notice for a revision (D5), derived from the notice mail's state. */
export type RevisionNoticeState = 'not-notified' | 'queued' | 'delivered' | 'failed' | 'uncertain'

/** An agent's statement that it works from a published revision (D6). */
export interface TaskAcknowledgement {
  sessionId: string
  revision: number
  /** The session's outstanding assignment for the task then, if any. */
  assignmentId: string | null
  createdAt: string
}

/**
 * One assignment holder of a published revision (D5). Notice state, delivered
 * revision, and acknowledged revision are separate facts — receipt is not
 * acknowledgement — and are never merged.
 */
export interface RevisionRecipient {
  assignmentId: string
  /** The outstanding assignment's current claimant. */
  sessionId: string
  noticeState: RevisionNoticeState
  /** The newest notice for this revision to this holder; null when none. */
  noticeMessageId: string | null
  /** Why a Failed or Uncertain notice is so; null otherwise. */
  reason: string | null
  /** Highest task revision carried by task mail confirmed delivered to the holder. */
  deliveredRevision: number | null
  /** The holder's highest acknowledged revision. */
  acknowledgedRevision: number | null
}

/** A published revision with its recipients (D5). */
export interface TaskPublication {
  revision: number
  previousRevision: number
  author: TaskCreator
  rationale: string | null
  notify: boolean | null
  publishedAt: string
  recipients: RevisionRecipient[]
}

export interface TaskJournalEntry {
  id: string
  author: JournalAuthor
  text: string
  createdAt: string
}

/**
 * One row of the agent's `task_list` (bounded-task-list D1): identifiers,
 * status, and a compact assignee and result — never the direction,
 * acceptance, assignment instruction, or participants (`task_get` has them).
 */
export interface AgentTaskRow {
  id: string
  title: string
  status: TaskStatus
  creator: TaskCreator
  parentId: string | null
  worktree: string | null
  openspecChange: string | null
  planId: string | null
  planChange: string | null
  revision: number
  createdAt: string
  updatedAt: string
  /** The outstanding assignment, projected; null when unassigned. */
  assignee: {
    targetKind: TeamTaskAssignment['targetKind']
    targetId: string
    role: string | null
    claimedBy: string | null
    state: TeamTaskAssignment['state']
  } | null
  /** The outstanding result, as `TeamTaskSummary.outstandingResult`; null when none. */
  result: { id: string; reviewVerdict: 'pass' | 'fail' | null; accepted: boolean; needsReevaluation: boolean } | null
}

/** The `task_list` status argument (D2): one task status, or every status. */
export type TaskListStatus = TaskStatus | 'all'

/** The agent's bounded task list (D3): newest first by creation, with the filter it applied. */
export interface AgentTaskList {
  tasks: AgentTaskRow[]
  /** The statuses the filter applied. */
  statuses: TaskStatus[]
  /** `total` counts every match of the filter, whatever the anchor. */
  bounds: { total: number; returned: number; truncated: boolean; nextBefore: string | null }
}

/** A task as listed: the record plus everyone who has worked under it. */
export interface TeamTaskSummary extends TeamTask {
  /** Agent session ids: creator, associated sessions, mail senders/receivers, journal authors. */
  participants: string[]
  /**
   * The outstanding assignment (task-assignment D1): the newest dispatch that
   * is neither superseded nor failed; null when the task is unassigned.
   */
  assignment: TeamTaskAssignment | null
  /**
   * The outstanding result's presence (task-results-handoffs D8); null when none was submitted.
   * `reviewVerdict` is the verdict of the newest findings bound to it (attention-acceptance-ownership), null without findings.
   */
  outstandingResult?: { id: string; needsReevaluation: boolean; accepted: boolean; reviewVerdict: 'pass' | 'fail' | null } | null
}

/**
 * One durable dispatch record (task-assignment D1): who is responsible, kept
 * separate from the derived participant list. The state is derived at read
 * time from the instruction mail (D5) — never a stored copy of it.
 */
export interface TeamTaskAssignment {
  id: string
  taskId: string
  /** The dispatch identity (D4): one user intent, unique within the team. */
  requestKey: string
  /** `group` (the group is the requested role) or `session` (a named member). */
  targetKind: 'group' | 'session'
  /** Group id, or session id. */
  targetId: string
  /** The requested role: the group id when one is known; null for a groupless session. */
  role: string | null
  /** The initial instruction, kept verbatim. */
  instruction: string
  createdBy: TaskCreator
  /** The enqueued instruction mail; null until dispatch committed it. */
  messageId: string | null
  /** Copied from the mail's claim; null while nobody has taken it. */
  claimedBy: string | null
  claimedAt: string | null
  /** The assignment that replaced this one; null while it stands. */
  supersededBy: string | null
  /** Derived state (D5): queued, claimed, delivered, failed, parked, forwarded, uncertain, superseded. */
  state: 'queued' | 'claimed' | 'delivered' | 'failed' | 'parked' | 'forwarded' | 'uncertain' | 'superseded'
  /** Why a failed assignment failed (dead-letter reason); null otherwise. */
  reason: string | null
  createdAt: string
  updatedAt: string
  /** A handoff (task-results-handoffs D1): its kind; null/absent for a plain dispatch. */
  handoffKind?: TaskHandoffKind | null
  /** The result a handoff references; null/absent for a plain dispatch. */
  resultId?: string | null
  /** What the handoff expects back (e.g. findings, a new result); null when unstated. */
  expectedResponse?: string | null
  /** The dispatch's worker choice for group mail (dispatch-worker-choice D1); absent when none. */
  workerChoice?: string | null
}

/** A handoff's kind (task-results-handoffs D3): review, QA, or a return for fixes. */
export type TaskHandoffKind = 'review' | 'qa' | 'fix'
export const TASK_HANDOFF_KINDS: readonly TaskHandoffKind[] = ['review', 'qa', 'fix']

/** One test a submitter reports running — a claim, never verified evidence (D2). */
export interface TaskTestClaim {
  description: string
  outcome: string
}

/** The status of one checked fact (independent-verification D2). */
export type ResultFactStatus = 'pass' | 'warn' | 'fail' | 'unknown'

/** How a result's commit relates to its worktree's HEAD (D2). */
export type ResultHeadRelation = 'same' | 'ahead' | 'behind' | 'diverged'

/**
 * The versioned facts one check recorded (independent-verification D2), at
 * most 64 KB as stored. Lists are capped (20 names plus a count, 30 compared
 * heads); a fact whose precondition is missing reads `unknown` with its
 * note. `head` and `clean` are null only when the check ended at the commit
 * fact — nothing else was checked; a worktree that exists but reads badly
 * carries `unknown` with the reason, and the commit is still checked from
 * the repository.
 */
export interface ResultCheckFacts {
  version: 1
  commit: {
    given: string | null
    sha: string | null
    /** True when the given text was not already a full sha. */
    resolvedAtCheckTime: boolean
    status: ResultFactStatus
    note: string | null
  }
  head: {
    sha: string | null
    branch: string | null
    relation: ResultHeadRelation | null
    ahead: number | null
    behind: number | null
    status: ResultFactStatus
    note: string | null
  } | null
  clean: {
    clean: boolean | null
    /** The first uncommitted paths, capped. */
    paths: string[]
    /** How many more uncommitted paths were found past the cap. */
    more: number
    status: ResultFactStatus
    note: string | null
  } | null
  recorded: {
    status: ResultFactStatus
    /** The matching record's facts, when one exists. */
    recordBun: string | null
    recordAt: string | null
    /** The commit's own .bun-version, when it has one. */
    commitBun: string | null
    note: string | null
  }
  base: {
    ref: string
    sha: string | null
    /** How many base commits the result lacks; null when unreadable. */
    behind: number | null
    mergeClean: boolean | null
    conflicts: string[]
    moreConflicts: number
    status: ResultFactStatus
    note: string | null
  }
  branches: {
    compared: Array<{
      taskId: string
      head: string
      conflicts: string[]
      moreConflicts: number
      overlap: string[]
      moreOverlap: number
      status: ResultFactStatus
    }>
    comparedCount: number
    /** Distinct heads found but not compared, past the cap. */
    skipped: number
    status: ResultFactStatus
  }
  /**
   * How the check resolved the result's coverage citations (independent-
   * verification D5): per clause, per citation, in the stored map's order —
   * the join with the map is positional. Present only when the result
   * carries a map and the check resolved it; absent otherwise, and dropped
   * from a sealed reader's view (D6: the outcomes give the map's shape away).
   */
  coverage?: CitationOutcome[][]
}

/** One stored check of one result (independent-verification D4). */
export interface TaskResultCheck {
  id: string
  teamId: string
  taskId: string
  resultId: string
  seq: number
  trigger: 'submit' | 'recheck'
  requestedBy: ActingParty
  status: 'pending' | 'done' | 'unavailable'
  /** The versioned facts; null while pending (and for an unavailable check). */
  facts: ResultCheckFacts | null
  /** Why a check is `unavailable`; null otherwise. */
  reason: string | null
  createdAt: string
  finishedAt: string | null
}

/** A result's checks as its readers see them (D12): the newest, and how many earlier ones exist. */
export interface TaskResultChecks {
  newest: TaskResultCheck | null
  earlier: number
}

/** Review or QA findings, bound to the exact result examined (D4). */
export interface TaskFindings {
  id: string
  taskId: string
  resultId: string
  /** The handoff the findings answer, when there was one. */
  handoffId: string | null
  kind: 'review' | 'qa'
  verdict: 'pass' | 'fail'
  findings: string
  author: TaskActor
  createdAt: string
}

/**
 * One submitted result (task-results-handoffs D1/D2): what was delivered, as
 * the submitter's claim. The newest result nothing supersedes is the task's
 * outstanding one; earlier results stay readable with their own findings.
 */
export interface TaskResult {
  id: string
  taskId: string
  summary: string
  commit: string | null
  diff: string | null
  /** Pinned at submission: the task's worktree, else the submitter's. */
  worktree: string | null
  /** Claimed test outcomes — shown labeled claimed, never verified. */
  tests: TaskTestClaim[]
  limitations: string | null
  /** The task revision pinned at submission. */
  taskRevision: number
  submittedBy: TaskActor
  /** The outstanding result this one superseded, if any. */
  supersedesResultId: string | null
  /** The result that superseded this one; null while it is outstanding. */
  supersededBy: string | null
  acceptedBy: ActingParty | null
  acceptedAt: string | null
  /** Derived at read time (D6): pinned revision older than the task's current one. */
  needsReevaluation: boolean
  /** Findings bound to this result, oldest first. */
  findings: TaskFindings[]
  /**
   * The submitter's coverage map (independent-verification D5) — its claim —
   * or the withheld form for a reviewer holding the task's outstanding
   * review handoff with no map recorded (D6). Null when the result carries
   * no map; absent on records written before that change.
   */
  coverage?: CoverageMap | WithheldCoverage | null
  /** Reviewer maps, newest per session, each with its comparison against the submitter's map (D12). */
  reviewerMaps?: ReviewerCoverageMap[]
  /** The reading session's own newest map against the submitter's, derived at read time (D6); null for the human and for a sealed reader. */
  comparison?: MapComparison | null
  /** Kawai's checks of this result, newest plus the earlier count (independent-verification D12); absent before that change. */
  checks?: TaskResultChecks
  createdAt: string
}

export interface TeamTaskDetail {
  task: TeamTaskSummary
  /** Oldest first; the last one is the current direction. */
  revisions: TaskRevision[]
  /** Append-only, oldest first. */
  journal: TaskJournalEntry[]
  subtasks: TeamTaskSummary[]
  /** Assignment history, oldest first (superseded rows stay visible). */
  assignments: TeamTaskAssignment[]
  /** Mail referencing the task, oldest first. */
  messages: TeamMessage[]
  /** Published revisions with their recipients, oldest first (task-revision-publication D5). */
  publications?: TaskPublication[]
  /** Every acknowledgement of the task, oldest first: the history behind each recipient's latest. */
  acknowledgements?: TaskAcknowledgement[]
  /** Results, outstanding first, then superseded ones newest first (task-results-handoffs D8). */
  results?: TaskResult[]
}

/** The agent's bounded detail (bounded-log-reads-and-task-get D4): journal, subtask, and message windows, oldest first, with their bounds; other sections whole. */
export interface AgentTaskDetail extends Omit<TeamTaskDetail, 'journal'> { journal: TaskJournalPreview[]; bounds: AgentTaskBounds }
export interface AgentTaskBounds { journal: { total: number; returned: number; olderRemaining: boolean; nextBefore: string | null }; subtasks: TaskListBound; messages: TaskListBound }
export interface TaskListBound { total: number; returned: number; truncated: boolean }
/** A journal entry's preview (D4): at most 2,000 stored bytes; `text` is null when they are not valid UTF-8, and `resumeOffsetBytes` is then 0. */
export interface TaskJournalPreview { id: string; author: JournalAuthor; createdAt: string; text: string | null; previewBytes: number; totalBytes: number; cut: boolean; resumeOffsetBytes: number }
/** One lossless chunk of a journal entry (D6): at most 8,192 stored bytes; `dataBase64` is authoritative, `text` null when not valid UTF-8. */
export interface TaskJournalChunk { entryId: string; offsetBytes: number; totalBytes: number; returnedBytes: number; dataBase64: string; text: string | null; nextOffsetBytes: number | null }

/**
 * The detail the human's UI receives: the agent-visible detail plus the
 * human's draft (D1). Agent paths (`task_get`) return `TeamTaskDetail`, which
 * has no draft field at all.
 */
export interface HumanTaskDetail extends TeamTaskDetail {
  draft?: TaskDraft | null
  /** What **Release worktree and hand off** would do now (task-results-handoffs D7). */
  release?: TaskReleasePreview
  /** A running execution owns the task (plan-execution D7): the view offers neither Accept result nor Mark done. */
  executionOwned?: boolean
}

/**
 * The release confirmation's data (task-results-handoffs D7): the task's live
 * spawned members it would archive, each with its readiness, and every other
 * live session working in the task's worktree — shown, never archived, and
 * not covered by the spawned-writer cap.
 */
export interface TaskReleasePreview {
  members: Array<{ sessionId: string; name: string; ready: boolean; reason: string | null }>
  others: Array<{ sessionId: string; name: string }>
  outstandingResultId: string | null
  /** Why the action is not offered (no worktree, no result, no spawned member); null when it is. */
  unavailable: string | null
}

/** The task section of a delivered peer message (design D3), built at delivery. */
export interface ChatPeerTaskContext {
  id: string
  title: string
  status: TaskStatus
  revision: number
  direction: string
  acceptance: string | null
  openspecChange: string | null
  worktree: string | null
  /** The most recent journal entries (at most five, each truncated), oldest first. */
  journal: Array<{ author: string; text: string; createdAt: string }>
  /**
   * The plan change the task serves (durable-plans D9), with the plan's
   * approved revision at delivery; absent for an unlinked task.
   */
  plan?: { id: string; title: string; revision: number | null; change: string }
  /** The running execution that owns the task, with the revision it runs (plan-execution D7); absent for an unowned task. */
  execution?: { id: string; revision: number }
}

/** An assignment's addressee: a group (its role) or one named session. */
export type AssignmentTarget = { kind: 'group' | 'session'; id: string }

/**
 * Read-only dispatch preview (task-assignment D6), computed from the same
 * sources the dispatcher uses. Informational: dispatch revalidates every
 * constraint, so a stale preview can mislead but cannot misroute.
 */
export interface TaskDispatchPreview {
  /** The target worktree the dispatched instruction would route by; null = none. */
  worktree: string | null
  target: AssignmentTarget
  /** The requested role: the group's label; null for a session target. */
  role: string | null
  /** Effective profile: a session target's profile, or the profile a spawn would use. */
  profile: string | null
  /** Approval policy of the spawned member (group target) or the session. */
  approval: 'manual' | 'auto'
  /** Where a group target's policy came from (team-approval-default D6); absent for a session target. */
  approvalSource?: 'group' | 'team' | 'built-in'
  /** A session target's resolved worktree; null for a group target. */
  sessionWorktree: string | null
  /** Idle members matching the target worktree (group targets); empty otherwise. */
  idleMembers: string[]
  /** Whether staffing could add a member, and what a spawn would use. */
  spawn: { allowed: boolean; profile: string | null; blockedBy: string | null }
  /** Advisory warning (e.g. a session target outside the task's worktree, or a cooling worker choice). */
  warning: string | null
  /**
   * The group target's worker choice (dispatch-worker-choice D7), absent
   * without one: its canonical selector, the group's models it resolves to,
   * and — when every candidate of the choice cools — the cooldown end the
   * instruction waits for.
   */
  worker?: { selector: string; profiles: string[]; cooldownUntil: string | null }
}

/** The pickers' data (task-assignment D8): team-scoped worktrees and changes. */
export interface TaskTargetOptions {
  worktrees: Array<{ root: string; branch?: string }>
  changes: Array<{ name: string; locations: string[] }>
  /** Open plans with an approved revision and that revision's change names (durable-plans D9). */
  plans?: Array<{ id: string; title: string; revision: number; changes: string[] }>
}
