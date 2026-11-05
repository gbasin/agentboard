// History sessions lookback limits (in hours)
export const HISTORY_MAX_AGE_MIN_HOURS = 1
export const HISTORY_MAX_AGE_MAX_HOURS = 168 // 7 days

// Question auto-answer wait limits (in whole minutes; 0 disables the deadline)
export const QUESTION_AUTO_ANSWER_MIN_MINUTES = 0
export const QUESTION_AUTO_ANSWER_MAX_MINUTES = 1440
export const QUESTION_AUTO_ANSWER_DEFAULT_MINUTES = 5

import type {
  MessageCursor,
  MessageQueryFilters,
  SessionDirectoryEntry,
  TeamMessage,
  TeamWorktreeOccupancy,
  ThreadEntry,
  WaitingReason,
} from './team'
import type { RuleLoadReport, TeamRoutingState } from './routing'
import type { HumanTaskDetail, TaskDispatchPreview, TaskHandoffKind, TaskStatus, TaskTargetOptions, TeamTask, TeamTaskAssignment, TeamTaskSummary } from './teamTasks'
import type { ProductStrategy, StrategyDetail, StrategyDraft, StrategyRevision } from './productStrategy'
import type { ImpactDecision, ImpactDisposition, StrategyImpactDetail } from './strategyImpact'
import type { TeamWorkspaceSnapshot } from './teamWorkspace'
import type { TeamCapacityAnswer } from './teamCapacity'
import type { PlanClientMessage, PlanServerMessage } from './planMessages'
import type { WorkspaceMessageEnvelope } from './planWorkspace'
import type { PlanWorkspaceClientMessage, PlanWorkspaceServerMessage } from './planWorkspaceMessages'
import type { OutboundAuditClientMessage, OutboundAuditServerMessage } from './outbound'
import type { MetricsClientMessage, MetricsServerMessage } from './metricsMessages'
import type {
  WorkspaceOperationResult,
  WorkspaceSnapshot,
} from './workspace'
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatContextExhausted,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatRuntime,
  ChatUsageReport,
  ChatWireFrame,
  ChatWorker,
  ChatBackgroundTask,
} from './chat'

export type {
  ChatActivity,
  ChatActivityPhase,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatNotificationSource,
  ChatNotificationSeverity,
  ChatNotificationPriority,
  ChatUsageReport,
  ChatUsageWindow,
  ChatUsageStatus,
  ChatQuestion,
  ChatQuestionAnswer,
  ChatPendingRequest,
  ChatRequestOutcome,
  ChatRequestDecidedBy,
  ChatRuntime,
  ChatApprovalPolicy,
  ChatApprovalDecision,
  ChatTurnResultSubtype,
  ChatCommand,
  ChatCommandSource,
  ChatCommandState,
  ChatWireDirection,
  ChatWireFrame,
  ChatWorker,
  ChatWorkerStatus,
  ChatBackgroundTask,
} from './chat'

export type {
  WorkspaceBranch,
  WorkspaceRepository,
  WorkspaceSnapshot,
  WorkspaceWorktree,
  WorktreeOpenSpecState,
  OpenSpecChangeSummary,
  WorkspaceOperationResult,
  WorkspaceErrorCode,
} from './workspace'

export type SessionStatus = 'working' | 'waiting' | 'permission' | 'unknown'

export type SessionSource = 'managed' | 'external'
export type AgentType = 'claude' | 'claude-rp' | 'codex' | 'pi'

/** First-prompt agents offered by the session form's "Start with" selector. */
export type AutoStartAgent = 'claude' | 'codex'
export type ClipboardOfferSource = 'tmux-buffer' | 'osc52'
export type SessionKillSource =
  | 'keyboard_shortcut'
  | 'session_list_context_menu'
  | 'terminal_confirm_modal'
  | 'unknown'
export type TerminalErrorCode =
  | 'ERR_INVALID_WINDOW'
  | 'ERR_SESSION_CREATE_FAILED'
  | 'ERR_START_TIMEOUT'
  | 'ERR_TMUX_ATTACH_FAILED'
  | 'ERR_TMUX_SWITCH_FAILED'
  | 'ERR_TTY_DISCOVERY_TIMEOUT'
  | 'ERR_NOT_READY'

/** Session kind: a tmux terminal window (default) or an SDK-driven chat. */
export type SessionKind = 'terminal' | 'chat'

/**
 * Who chose a chat session's name (chat-session-naming design D1). `manual` is
 * terminal: once a person has set a name, no generated title replaces it.
 * `placeholder` came from `generateSessionName()`; `auto` was adopted from a
 * title the agent generated and is still followed until a person claims it.
 */
export type ChatNameSource = 'manual' | 'auto' | 'placeholder'

/**
 * A session backed by a tmux window. Everything tmux discovery produces has
 * `tmuxWindow` set; chat sessions do not, so window-keyed code narrows with
 * `isTerminalSession` before touching the field.
 */
export type TerminalSession = Session & { tmuxWindow: string }

export function isTerminalSession(session: Session): session is TerminalSession {
  return session.kind !== 'chat' && session.tmuxWindow !== undefined
}

export interface Session {
  id: string
  name: string
  // Undefined for chat sessions (no tmux window backs them).
  tmuxWindow?: string
  projectPath: string
  status: SessionStatus
  lastActivity: string
  createdAt: string
  // Absent = terminal (back-compat with clients predating chat sessions).
  kind?: SessionKind
  claudeProfileId?: string
  /** Chat sessions only: approval policy; absent = manual (legacy sessions). */
  approvalPolicy?: ChatApprovalPolicy
  /** Chat sessions only: the runtime fixed at the chat's creation (R1); absent = claude. */
  runtime?: ChatRuntime
  /** Chat sessions only: who chose `name`; absent = manual (never overwritten). */
  nameSource?: ChatNameSource
  agentType?: AgentType
  source: SessionSource
  host?: string
  remote?: boolean
  command?: string
  agentSessionId?: string
  agentSessionName?: string
  logFilePath?: string
  lastUserMessage?: string
  isPinned?: boolean
  /** Chat sessions only: archive timestamp (design D1); set = archived. */
  archivedAt?: string | null
  /** Chat sessions only: team group id (agent-teams); absent = no group. */
  groupId?: string
  /** The group's display label; absent until the session's team is known. */
  groupLabel?: string
  /** True when no group file defines `groupId` any more. */
  groupMissing?: boolean
  /** Chat sessions only: the team task it works on (team-tasks); absent = none. */
  taskId?: string
  /** That task's current title; absent when the task is unknown. */
  taskTitle?: string
  /** Created by worktree staffing, not by the human (team-tasks D4). */
  spawned?: boolean
  /** Paused after a provider limit with work parked on it (profile routing); null/absent = not paused. */
  parked?: SessionParkedState | null
  /** Chat sessions only: a turn failed on a context limit (chat-context-exhaustion D3); null/absent = not flagged. */
  contextExhausted?: ChatContextExhausted | null
}

/** Why and until when a chat session is paused (profile routing). */
export interface SessionParkedState {
  messageId: string
  /** When the scheduled resume is due; null when unknown. */
  until: string | null
  profileId: string
  reason: string
}

export interface AgentSession {
  sessionId: string
  logFilePath: string
  projectPath: string
  agentType: AgentType
  displayName: string
  createdAt: string
  lastActivityAt: string
  isActive: boolean
  host?: string
  lastUserMessage?: string
  isPinned?: boolean
  lastResumeError?: string
}

export interface HostStatus {
  host: string
  ok: boolean
  lastUpdated: string
  error?: string
}

// Directory browser types
export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryListing {
  path: string
  parent: string | null
  directories: DirectoryEntry[]
  truncated: boolean
}

export interface DirectoryErrorResponse {
  error: 'invalid_path' | 'forbidden' | 'not_found' | 'internal_error'
  message: string
}

/**
 * The server's update-discovery result: the running build, and the release
 * to offer when a newer base version exists. `target` is null while the
 * running base is current (or discovery has not found anything), so a
 * missing signal and a current build look the same — by design, discovery
 * fails silent.
 */
export interface UpdateState {
  /** Running build version, e.g. `1.0.0-17` or `1.0.0-dev`. */
  current: string
  /** The release an update would move to; null when current. */
  target: null | {
    /** Release tag, e.g. `v1.1.0-12`. */
    tag: string
    /** `MAJOR.MINOR.PATCH` base of the tag. */
    base: string
    /** Release page, when the API provided one. */
    htmlUrl: null | string
  }
}

export type ServerMessage =
  // Durable plans (durable-plans D12): see planMessages.ts.
  | PlanServerMessage
  // The plan workspace (plan-workspace D1): see planWorkspaceMessages.ts.
  | PlanWorkspaceServerMessage
  // The owner's audit view (execution-safety-recovery D9): see outbound.ts.
  | OutboundAuditServerMessage
  // Process metrics (team-process-metrics D5): see metricsMessages.ts.
  | MetricsServerMessage
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'session-update'; session: Session }
  | { type: 'session-created'; session: Session }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'host-status'; hosts: HostStatus[] }
  | { type: 'agent-sessions'; active: AgentSession[]; hibernating: AgentSession[]; history: AgentSession[] }
  | { type: 'agent-sessions-active'; active: AgentSession[] }
  | { type: 'session-orphaned'; session: AgentSession; supersededBy?: string }
  | { type: 'session-activated'; session: AgentSession; window: string }
  | { type: 'session-wake-result'; sessionId: string; ok: boolean; session?: Session; error?: WakeError }
  | {
      type: 'session-hibernate-result'
      sessionId: string
      ok: boolean
      session?: AgentSession
      error?: string
    }
  | { type: 'session-move-to-history-result'; sessionId: string; ok: boolean; session?: AgentSession; error?: string }
  // Workspace messages are additive: older clients can ignore them and all
  // existing session messages/fields are unchanged.
  | { type: 'workspace-snapshot'; snapshot: WorkspaceSnapshot }
  | { type: 'workspace-operation-result'; result: WorkspaceOperationResult }
  | { type: 'terminal-output'; sessionId: string; data: string }
  | {
      type: 'terminal-error'
      sessionId: string | null
      code: TerminalErrorCode
      message: string
      retryable: boolean
    }
  | { type: 'terminal-ready'; sessionId: string }
  | {
      type: 'clipboard-offer'
      sessionId: string
      text: string
      source: ClipboardOfferSource
    }
  | {
      type: 'tmux-copy-mode-status'
      sessionId: string
      inCopyMode: boolean
      // Fullscreen-app (Claude /tui no-flicker) detection, per-pane.
      // altScreen: pane is showing the alternate screen buffer (#{alternate_on}).
      // appMouse: the in-pane app has requested mouse tracking (#{mouse_any_flag}).
      // When appMouse is true the app owns the mouse, so the client must NOT
      // hijack wheel/clicks into tmux copy-mode. Optional for back-compat.
      altScreen?: boolean
      appMouse?: boolean
    }
  | { type: 'server-config'; remoteAllowControl: boolean; remoteAllowAttach: boolean; hostLabel: string; preferWindowName: boolean; clientLogLevel?: string }
  // Question auto-answer wait changed (question-auto-answer D5): open
  // Settings dialogs update to the new value.
  | { type: 'question-auto-answer-changed'; minutes: number }
  // Update availability is additive too: older clients ignore it, and the
  // payload rides server-info for first paint and this push for changes.
  | { type: 'update-state'; update: UpdateState }
  // Chat messages are additive (like the workspace messages above): older
  // clients ignore unknown message types; terminal behavior is unchanged.
  | { type: 'chat-events'; sessionId: string; events: ChatEvent[] }
  | {
      type: 'chat-snapshot'
      sessionId: string
      /** Claude profile of the session; keys the client's per-profile usage. */
      profileId: string
      /** Read-only replayed history plus unfinished live transcript. */
      events: ChatEvent[]
      pendingRequests: ChatPendingRequest[]
      status: SessionStatus
      /** Highest sequence included in this snapshot. */
      throughSequence: number
      /** The session's slash-command list (replaceable state, not history). */
      commands: ChatCommandState
      /** Current in-flight turn activity, or null when the turn is idle. */
      activity: ChatActivity | null
      /**
       * Latest context-usage reading for the session, or null before the
       * first model request (context meter design D7: no reading is a state,
       * not a zero). Slow session state like `status`, not ephemeral like
       * `activity` — it also persists with the chat session.
       */
      contextUsage: ChatContextUsage | null
      /**
       * Model the agent last reported for the session (its init frame), or
       * null before the first report — slow session state like
       * `contextUsage`, persisted with the chat session, never a sequenced
       * event.
       */
      model: string | null
      /** Latest plan-usage report for the session's profile, when one is held. */
      usage: ChatUsageReport | null
      /**
       * Agents the session spawned (workers design D2): the full roster at
       * snapshot time — running ones live, settled ones with their outcomes.
       */
      workers: ChatWorker[]
      /**
       * Background shells and Monitors the agent started (background tasks
       * D2): the full roster at snapshot time, running and settled alike.
       */
      backgroundTasks: ChatBackgroundTask[]
      /**
       * The session's active notices (notification strip design D1): its
       * profile's account notices followed by its own agent notices, sorted by
       * priority and newest. Additive and ephemeral — never persisted,
       * sequenced, or replayed.
       */
      notifications: ChatNotification[]
      /**
       * The recent history window (chat-history-window D2): `events` is the
       * window, everything older is pageable through chat-history-page.
       * `historyHasOlder` is absent from older servers and reads false;
       * `historyStartId` names the window's first event — the client's
       * reconnect `historyFrom` and page `beforeId`.
       */
      historyHasOlder?: boolean
      historyStartId?: string | null
    }
  // One history page (chat-history-window D2): the 24 hours before the unit
  // holding beforeId, at least one turn, sent to the asking connection only.
  // `stale` with no events means beforeId is not in the server's list and
  // the client must re-attach without historyFrom.
  | {
      type: 'chat-history-page'
      sessionId: string
      beforeId: string
      events: ChatEvent[]
      hasOlder: boolean
      stale?: boolean
    }
  // Replaced command list pushed to subscribed connections whenever the
  // agent reports a changed list (or the state changes). Additive: older
  // clients ignore the unknown message.
  | { type: 'chat-commands'; sessionId: string; state: ChatCommandState }
  // Ephemeral live activity for an in-flight chat turn (design D1): sent only
  // on phase changes, unordered with events, never persisted or replayed.
  | { type: 'chat-activity'; sessionId: string; activity: ChatActivity | null }
  // Latest plan usage for a session's provider (usage bar design D4,
  // providers-and-workers 5.3): fanned out per subscribed session of the
  // provider on each new report, each message named by that session's own
  // `profileId` — the client keys its meter per profile — with `providerId`
  // additive for clients that group by provider. Ephemeral like chat-activity.
  | { type: 'chat-usage'; profileId: string; providerId: string; report: ChatUsageReport | null }
  // Latest context-usage reading for a chat session (context meter design D5):
  // coalesced like chat-activity — only the latest value survives until the
  // flush — additive, never sequenced or replayed. A null `usage` clears the
  // meter (a conversation reset leaves nothing measured, design D7).
  | {
      type: 'chat-context-usage'
      sessionId: string
      usage: ChatContextUsage | null
    }
  // Model the agent last reported for a chat session (its init frame): sent
  // only when it changes — the value never clears, so the push carries a
  // string. Coalesced like chat-context-usage; additive, never sequenced or
  // replayed (the snapshot carries the current value instead).
  | { type: 'chat-model'; sessionId: string; model: string }
  // Full worker roster of a chat session (workers design D2): a level signal,
  // not deltas — a missed bookend must not wedge a stale running worker. Sent
  // whenever the roster projection changes; additive and ephemeral like
  // chat-activity, while settled outcomes also ride the snapshot and persist.
  // Team mailbox snapshot. `waiting` and `worktrees` are additive optional
  // fields (team-waiting-reasons D3): per-message waiting reasons and the
  // worktree occupancy read model, ignored by older clients (the precedent
  // is `routing`). Reasons are in-memory state — absent until the first
  // dispatch pass after a restart rebuilds them.
  | {
      type: 'team-mailbox-snapshot'
      teamPath: string
      teamId: string
      messages: TeamMessage[]
      routing?: TeamRoutingState
      waiting?: Record<string, WaitingReason>
      worktrees?: TeamWorktreeOccupancy[]
    }
  | { type: 'team-mailbox-rules-result'; teamPath: string; ok: true; report: RuleLoadReport }
  | { type: 'team-mailbox-rules-result'; teamPath: string; ok: false; error: string }
  | { type: 'team-mailbox-hand-off-result'; teamPath: string; messageId: string; ok: true; forwardedId: string }
  | { type: 'team-mailbox-hand-off-result'; teamPath: string; messageId: string; ok: false; error: string }
  | { type: 'team-mailbox-dead-letter'; teamId: string; messageId: string; senderSession: string | null }
  // A reply reached the human (team-message-threads D5): settled on send, so
  // a toast is the only client-side signal. Additive and ephemeral.
  | { type: 'team-mailbox-delivered-to-human'; teamId: string; messageId: string; senderSession: string | null; senderKind: 'agent' | 'human' | 'system' }
  // Team tasks (team-tasks 6.1): authoritative snapshots for an addressed
  // team — the list, and each task whose detail the connection has open.
  | { type: 'team-tasks-snapshot'; teamPath: string; teamId: string; tasks: TeamTaskSummary[] }
  | {
      type: 'team-task-detail'
      teamPath: string
      teamId: string
      /** The human's view: the task detail plus its draft (task-revision-publication D1). */
      detail: HumanTaskDetail
      /** Last known identity of killed participants named by its messages. */
      directory: SessionDirectoryEntry[]
    }
  // Result of a human task action; `task` is set on success (a created
  // task's id lets the view open it), `error` on refusal. A dispatch
  // additionally returns its assignment (task-assignment 4.1).
  | {
      type: 'team-task-result'
      teamPath: string
      requestId: string
      task?: TeamTask
      /** The assignment a `team-task-assign` created or replayed. */
      assignment?: TeamTaskAssignment
      /** The revision a `team-task-publish` published or replayed. */
      revision?: number
      /** True when a keyed publish or notify had already run: nothing new was written. */
      replay?: boolean
      error?: string
    }
  // Read-only dispatch preview (task-assignment 4.1): informational — the
  // same request revalidated at dispatch.
  | {
      type: 'team-task-preview-result'
      teamPath: string
      requestId: string
      preview?: TaskDispatchPreview
      error?: string
    }
  // The worker picker's data (dispatch-worker-choice 4.3): the same answer the
  // `team_capacity` tool gives, read for the addressed team.
  | {
      type: 'team-task-capacity-result'
      teamPath: string
      requestId: string
      capacity?: TeamCapacityAnswer
      error?: string
    }
  // The pickers' team-scoped worktrees and OpenSpec changes (task-assignment 4.1).
  | {
      type: 'team-task-targets-result'
      teamPath: string
      requestId: string
      targets?: TaskTargetOptions
      error?: string
    }
  // Messages view (team-message-threads 5.1): the authoritative page of a
  // subscription's filters on open and reconnect, then pushes of the rows
  // that changed. Pushes are unfiltered — a watcher on `state:queued` has to
  // hear about the claim that drops a row out of its list. Thread detail is
  // its own replace-semantics reply, re-sent when its thread changes.
  | {
      type: 'team-messages-snapshot'
      teamPath: string
      teamId: string
      filters: MessageQueryFilters
      messages: TeamMessage[]
      nextCursor: MessageCursor | null
      /** Last known identity of killed participants named by these rows. */
      directory: SessionDirectoryEntry[]
      /** The team's tasks, so the composer can attach one without the Tasks panel. */
      tasks: { id: string; title: string }[]
      /** Whole-thread message counts for the threads on this page (team-workspace-pages D7). */
      threadSizes: Record<string, number>
    }
  // Carries the team directory like the snapshot, so a text search names a
  // participant recorded since the last snapshot (team-workspace-pages D7).
  | { type: 'team-messages'; teamPath: string; teamId: string; messages: TeamMessage[]; directory: SessionDirectoryEntry[] }
  | {
      type: 'team-thread'
      teamPath: string
      teamId: string
      threadId: string
      entries: ThreadEntry[]
      directory: SessionDirectoryEntry[]
    }
  // Result of a human send or reply; `message` is set on success (the row the
  // composer's thread will show), `error` on refusal. `requestId` is the
  // client's own and never lands in a durable row.
  | {
      type: 'team-message-send-result'
      teamPath: string
      requestId: string
      message?: TeamMessage
      error?: string
    }
  // Product strategy (product-strategy 3.1/5.1): authoritative snapshots for
  // the addressed team — the summary (null = no record; the view offers
  // capture) and, when a record exists, its full detail. Re-sent whole on
  // every committed strategy change, so a reconnect needs no deltas.
  | { type: 'strategy-snapshot'; teamPath: string; teamId: string; strategy: ProductStrategy | null }
  // `impact` (strategy-revision-impact D9) is composed beside the stored
  // detail: the reviews with their records and the current assessment.
  | { type: 'strategy-detail'; teamPath: string; teamId: string; detail: StrategyDetail; impact?: StrategyImpactDetail | null }
  // Result of a human strategy action: the saved draft (its hash feeds the
  // next save's CAS) or the submitted revision on success; `error` on
  // refusal, with `conflict` carrying the stored draft when a CAS refusal
  // leaves the caller's own text in place (S12).
  | {
      type: 'strategy-result'
      teamPath: string
      requestId: string
      draft?: StrategyDraft
      revision?: StrategyRevision
      /** An impact decision recorded (or replayed) by `strategy-impact-decide`. */
      decision?: ImpactDecision
      /** The assessment request's message id (`strategy-impact-request`). */
      messageId?: string
      /** True when a keyed impact command replayed its recorded result. */
      replayed?: boolean
      error?: string
      conflict?: StrategyDraft | null
    }
  // Team workspace (team-workspace 5.1): one authoritative snapshot on open
  // and reconnect, then full-set replace pushes — unfiltered like the task
  // snapshot, so the client applies its own filters. The read model owns no
  // tables (design D1); every set is recomputed from the stores it reads.
  | ({ type: 'team-workspace-snapshot'; teamPath: string; teamId: string } & TeamWorkspaceSnapshot)
  | ({ type: 'team-workspace'; teamPath: string; teamId: string } & TeamWorkspaceSnapshot)
  // The answer to a team default approval save (team-approval-default D4):
  // every outcome carries `teamPath`, a refusal names what was refused.
  | { type: 'team-workspace-approval-default-result'; teamPath: string; ok: true; policy: ChatApprovalPolicy }
  | { type: 'team-workspace-approval-default-result'; teamPath: string; ok: false; error: string }
  | { type: 'chat-workers'; sessionId: string; workers: ChatWorker[] }
  // Full background-task roster of a chat session (background tasks D2): a
  // level signal like chat-workers — the whole set on every change, additive
  // and ephemeral on the wire, while settled outcomes persist in the sidecar.
  | { type: 'chat-background-tasks'; sessionId: string; tasks: ChatBackgroundTask[] }
  // A background task's output tail (background tasks D3): the reply to
  // chat-task-output. 'ok' carries at most the last 8 KiB as plain text
  // (truncated notes that earlier output was cut); 'unavailable' covers a
  // missing method, a throwing read, and a cleaned-up output file — the row
  // shows the panel as unavailable, never an error.
  | {
      type: 'chat-task-output'
      sessionId: string
      taskId: string
      state: 'ok' | 'unavailable'
      output?: string
      totalBytes?: number
      truncated?: boolean
    }
  // A chat session's active notices (notification strip design D5): the full
  // replace-semantics list, pushed to subscribed connections whenever it
  // changes — a missed push heals on the next one. Additive and ephemeral
  // like chat-activity: never sequenced, persisted, or replayed.
  | { type: 'chat-notifications'; sessionId: string; notifications: ChatNotification[] }
  // A worker's body on expand (workers design D5): the reply to
  // chat-worker-transcript, read from the worker's on-disk transcript.
  // 'unavailable' reports a missing file or unknown worker (the row shows
  // the body as unavailable, never an error).
  | {
      type: 'chat-worker-transcript'
      sessionId: string
      workerId: string
      status: 'ok' | 'unavailable'
      events: ChatEvent[]
    }
  // Debug-view protocol frames, sent only to clients that opened the view.
  // `page: true` marks a reply to chat-debug-open/chat-debug-page (carrying
  // `hasOlder`); otherwise the message is a live batch.
  | {
      type: 'chat-debug-frames'
      sessionId: string
      frames: ChatWireFrame[]
      page?: boolean
      hasOlder?: boolean
    }
  | { type: 'pong'; seq?: number }
  // A refusal. For a chat-send that carried a readable `requestId` (§6.3,
  // Lead-authorized Q2), the reply echoes it with `sessionId` so the client
  // can restore the draft and its captured attachment; other errors carry
  // neither field, exactly as before.
  | { type: 'error'; message: string; requestId?: string; sessionId?: string }
  // The sender-only acceptance answer for a chat-send that carried a readable
  // `requestId` (plan-workspace §6.3, B1): sent to the sending connection
  // only, once the manager accepted the send — past the last refusal point.
  // Never a ChatEvent: not sequenced, persisted, replayed, or broadcast; a
  // send carries either this or its correlated refusal, never both, and a
  // send without a readable requestId carries neither.
  | { type: 'chat-send-result'; sessionId: string; requestId: string; accepted: true }
  | { type: 'kill-failed'; sessionId: string; message: string }

export interface WakeError {
  code: 'NOT_FOUND' | 'ALREADY_ACTIVE' | 'WAKE_FAILED' | 'WAKE_IN_PROGRESS'
  message: string
}

export type ClientMessage =
  // Durable plans (durable-plans D12): see planMessages.ts.
  | PlanClientMessage
  // The plan workspace (plan-workspace D1): see planWorkspaceMessages.ts.
  | PlanWorkspaceClientMessage
  // The owner's audit view (execution-safety-recovery D9/D10): see outbound.ts.
  | OutboundAuditClientMessage
  // Process metrics (team-process-metrics D5): see metricsMessages.ts.
  | MetricsClientMessage
  | {
      type: 'terminal-attach'
      sessionId: string
      tmuxTarget?: string
      cols?: number
      rows?: number
    }
  | { type: 'terminal-detach'; sessionId: string }
  | { type: 'terminal-input'; sessionId: string; data: string }
  // Pasted text delivered as a single bracketed paste (via tmux paste-buffer),
  // so multi-line content isn't auto-submitted line-by-line by the pane's app.
  | { type: 'terminal-paste'; sessionId: string; data: string }
  | { type: 'terminal-resize'; sessionId: string; cols: number; rows: number }
  | {
      type: 'session-create'
      projectPath: string
      name?: string
      command?: string
      host?: string
      // Session kind: absent = terminal (tmux) session, unchanged behavior;
      // 'chat' creates an SDK-driven chat session instead of a window.
      kind?: SessionKind
      claudeProfileId?: string
      // Chat sessions only: starting approval policy (reorg-settings-default-
      // approval design D3). Absent = manual, so older clients and terminal
      // sessions are unchanged.
      approvalPolicy?: ChatApprovalPolicy
      // Chat sessions only: team group (agent-teams), validated against the
      // project's group catalog and fixed for the session's life. Absent =
      // no group.
      groupId?: string
      /** Existing chat whose stored role is preserved, including a missing role. */
      cloneFromSessionId?: string
      // OpenSpec change context: with a selected agent, the server composes
      // the mapped apply command into the session's start command as the
      // agent's first prompt (a launch argument, held by the agent itself
      // until trust/login gates clear). Absent agent = no first prompt.
      autoStartChange?: string
      autoStartAgent?: AutoStartAgent
    }
  | { type: 'session-kill'; sessionId: string; source?: SessionKillSource }
  | { type: 'session-rename'; sessionId: string; newName: string }
  | { type: 'session-refresh' }
  | { type: 'tmux-cancel-copy-mode'; sessionId: string }
  | { type: 'tmux-check-copy-mode'; sessionId: string }
  | { type: 'session-wake'; sessionId: string }
  | { type: 'session-hibernate'; sessionId: string }
  | { type: 'session-move-to-history'; sessionId: string }
  // Chat messages are additive: existing clients never send them.
  // historyFrom (chat-history-window D2): the oldest event id the client
  // holds, so a reconnect's snapshot covers the span it already showed.
  // Absent (older clients) = the recent window.
  | { type: 'chat-attach'; sessionId: string; historyFrom?: string }
  | { type: 'chat-detach'; sessionId: string }
  // Load earlier history (chat-history-window D2): the 24 hours before the
  // oldest held event, widened back to throughId when a search reveal needs
  // an older entry (an event id or a tool:<callId> anchor).
  | { type: 'chat-history-page'; sessionId: string; beforeId: string; throughId?: string }
  | { type: 'chat-send'; sessionId: string; text: string; /** Plan-workspace context (§4): validated server-side before anything is stored. */ workspaceContext?: WorkspaceMessageEnvelope; /** Client-minted correlation (§6.3, Q2): echoed on every refusal, absent on acceptance. */ requestId?: string }
  | { type: 'chat-interrupt'; sessionId: string }
  // Archive stops the agent process but keeps the record, conversation, and
  // protocol log; restore clears the archived state (chat-archive design D2).
  // Both idempotent; confirmation for in-flight turns is a client concern (D3).
  | { type: 'chat-archive'; sessionId: string }
  | { type: 'chat-restore'; sessionId: string }
  | {
      type: 'chat-approval'
      sessionId: string
      requestId: string
      decision: ChatApprovalDecision
    }
  | {
      type: 'chat-answer'
      sessionId: string
      requestId: string
      /** Answers keyed by question text (matches the SDK's answer map). */
      answers: Record<string, ChatQuestionAnswer>
    }
  // Hold a question's auto-answer deadline — Wait for me (question-auto-answer
  // D4): the question waits for the user and never auto-answers.
  | {
      type: 'chat-question-hold'
      sessionId: string
      requestId: string
    }
  // Switches the session's approval policy live (chat-auto-approve-tools
  // design D4): manual/auto only, no agent restart.
  | {
      type: 'chat-set-approval-policy'
      sessionId: string
      policy: ChatApprovalPolicy
    }
  // Human team views (team-workspace-pages D1) address a team, not a chat:
  // `teamPath` is a directory — a repository's main checkout, or a chat's
  // project directory — that the server resolves to its team and accepts
  // only for a discovered repository or an existing chat's team (refused as
  // `unknown-team`). Replies echo the same `teamPath` beside the `teamId`.
  | { type: 'team-mailbox-open' | 'team-mailbox-close'; teamPath: string }
  | { type: 'team-mailbox-cancel' | 'team-mailbox-retry' | 'team-mailbox-discard'; teamPath: string; messageId: string }
  | { type: 'team-mailbox-reload-rules'; teamPath: string }
  | { type: 'team-mailbox-hand-off'; teamPath: string; messageId: string; target: { kind: 'group' | 'session'; id: string } }
  // Team tasks (team-tasks 6.1/6.2): list and detail subscriptions scoped by
  // the addressed team; human actions answer with team-task-result.
  | { type: 'team-tasks-open' | 'team-tasks-close'; teamPath: string }
  | { type: 'team-task-open' | 'team-task-close'; teamPath: string; taskId: string }
  | {
      type: 'team-task-create'
      teamPath: string
      requestId: string
      title: string
      direction: string
      acceptance?: string
      parentId?: string
      worktree?: string
      openspecChange?: string
      /** The plan-change link (durable-plans D9): both or neither. */
      planId?: string
      planChange?: string
      /** Stable per intent (task-assignment D4): a replay returns the prior task. */
      requestKey?: string
    }
  // Task-revision publication (D1, D2, D4): the human's draft (save, rebase
  // onto the current revision, discard), a keyed publication from a named
  // base, and keyed notify/retry of a published revision.
  | {
      type: 'team-task-draft'
      teamPath: string
      requestId: string
      taskId: string
      action: 'save' | 'rebase' | 'discard'
      baseRevision?: number
      direction?: string
      acceptance?: string
      rationale?: string
    }
  | {
      type: 'team-task-publish'
      teamPath: string
      requestId: string
      taskId: string
      baseRevision: number
      /** Minted when the action arms; reused on every resend, so a replay returns the prior revision. */
      requestKey: string
      direction: string
      acceptance?: string
      rationale: string
      notify: boolean
      /** Published from the human's saved draft, which is discarded with it. */
      fromDraft?: boolean
    }
  | { type: 'team-task-notify'; teamPath: string; requestId: string; taskId: string; revision: number; requestKey: string }
  // Task results (task-results-handoffs D5): accept one result and close the
  // task under the existing closing rights; a reason when it is flagged or
  // child work is open.
  | { type: 'team-task-accept-result'; teamPath: string; requestId: string; taskId: string; resultId: string; reason?: string }
  // Request a new check of one result (independent-verification D4); a
  // request while a check is pending returns that pending check.
  | { type: 'team-task-recheck'; teamPath: string; requestId: string; taskId: string; resultId: string }
  // Request review / Request QA / Return for fixes (D3): a handoff of one
  // result to a role, idempotent under the client's request key.
  | {
      type: 'team-task-handoff'
      teamPath: string
      requestId: string
      taskId: string
      kind: TaskHandoffKind
      resultId: string
      target: { kind: 'group' | 'session'; id: string }
      instructions: string
      expectedResponse?: string
      requestKey: string
      /** Optional worker choice for a group target (dispatch-worker-choice D7): normalized and validated by the server. */
      worker?: string
    }
  // Release worktree and hand off (D7): archive the task's ready spawned
  // members, then dispatch the review handoff to a reviewer group.
  | {
      type: 'team-task-release'
      teamPath: string
      requestId: string
      taskId: string
      target: string
      instructions: string
      expectedResponse?: string
      requestKey: string
      /** Optional worker choice for a group target (dispatch-worker-choice D7): normalized and validated by the server. */
      worker?: string
    }
  | { type: 'team-task-note'; teamPath: string; requestId: string; taskId: string; text: string }
  | { type: 'team-task-status'; teamPath: string; requestId: string; taskId: string; status: TaskStatus }
  // Human dispatch of a task's instruction (task-assignment 4.1): idempotent
  // under `requestKey`; `handling` is required when the task has an
  // outstanding assignment (the refusal names it).
  | {
      type: 'team-task-assign'
      teamPath: string
      requestId: string
      taskId: string
      target: { kind: 'group' | 'session'; id: string }
      instruction: string
      requestKey: string
      handling?: 'notify' | 'stop'
      /** Optional worker choice for a group target (dispatch-worker-choice D7): normalized and validated by the server. */
      worker?: string
    }
  // Read-only preview of a dispatch: the task's stored worktree, or the
  // worktree the create form has (resolved by the same server rules).
  | {
      type: 'team-task-preview'
      teamPath: string
      requestId: string
      taskId?: string
      worktree?: string
      target: { kind: 'group' | 'session'; id: string }
      /** A group target's worker choice (dispatch-worker-choice 4.2). */
      worker?: string
    }
  // The pickers' data (worktrees with branches, changes with locations).
  // `worktree` narrows the change list to the roots validateChange accepts
  // for it (the main checkout plus that worktree); the worktree list stays
  // team-wide.
  | { type: 'team-task-targets'; teamPath: string; requestId: string; worktree?: string }
  // The worker picker's data (dispatch-worker-choice 4.3): the team's capacity,
  // or only `group`'s.
  | { type: 'team-task-capacity'; teamPath: string; requestId: string; group?: string }
  // Messages view (team-message-threads 5.1): a list subscription carries the
  // filters (and optional page cursor) the view is on; a thread open carries
  // the thread to keep live. Human sends and replies are one message — `to`
  // starts mail, `inReplyTo` answers it — carrying a client request id the
  // result echoes. Request ids live on the wire only.
  | {
      type: 'team-messages-open'
      teamPath: string
      filters?: MessageQueryFilters
      cursor?: MessageCursor
    }
  | { type: 'team-messages-close'; teamPath: string }
  | { type: 'team-thread-open'; teamPath: string; threadId: string }
  | { type: 'team-thread-close'; teamPath: string; threadId: string }
  | {
      type: 'team-message-send'
      teamPath: string
      requestId: string
      body: string
      urgent?: boolean
      tags?: string[]
      taskId?: string
      /** Recipient of new mail. Mutually exclusive with `inReplyTo`. */
      to?: { kind: 'group' | 'session'; id: string }
      /** Message to answer; the reply joins its thread. */
      inReplyTo?: string
    }
  // Product strategy (product-strategy 3.1/5.1): the view subscription
  // scoped by the addressed team, and the human actions. Approval and
  // withdrawal arrive only here — there is no agent tool for them (D3).
  | { type: 'strategy-open' | 'strategy-close'; teamPath: string }
  // Team workspace (team-workspace 5.1): the repository-level read model
  // subscription, addressed like every human team view by `teamPath`.
  | { type: 'team-workspace-open' | 'team-workspace-close'; teamPath: string }
  // The human sets the team's default approval policy for spawned members
  // (team-approval-default D4); no agent tool reaches it. `policy` is checked
  // on the server, so a bad wire value is refused, never stored.
  | { type: 'team-workspace-approval-default-set'; teamPath: string; policy: ChatApprovalPolicy }
  | {
      type: 'strategy-save-draft'
      teamPath: string
      requestId: string
      /** Capture (no record yet, human only): the product slug and title. */
      productId?: string
      title?: string
      draftId?: string
      /** Template content object; normalized server-side. */
      content: unknown
      impactProposal?: string
      expectedBaseRevision?: number | null
      expectedDraftHash?: string | null
    }
  | { type: 'strategy-submit'; teamPath: string; requestId: string; draftId?: string }
  | {
      type: 'strategy-approve'
      teamPath: string
      requestId: string
      revision: number
      contentHash: string
      /** Stable across retries: idempotency key (S17). */
      commandId: string
      /** CAS: the active approved revision the client saw (D4). */
      expectedCurrentRevision: number | null
      approvalScope?: string
      openQuestions?: string
    }
  | { type: 'strategy-withdraw'; teamPath: string; requestId: string; revision?: number; draftId?: string; commandId: string }
  // The owner's impact decision (strategy-revision-impact D4): one
  // disposition for an affected plan in the current review, CAS'd on the
  // effective decision the dialog showed; one command id per dialog.
  | {
      type: 'strategy-impact-decide'
      teamPath: string
      requestId: string
      reviewId: string
      planId: string
      disposition: ImpactDisposition
      rationale: string
      proposalId?: string
      expectedDecisionId: string | null
      commandId: string
    }
  // Ask a group to assess the current review (D8): one human message, keyed by command id.
  | { type: 'strategy-impact-request'; teamPath: string; requestId: string; reviewId: string; group: string; commandId: string }
  | { type: 'chat-debug-open'; sessionId: string }
  | { type: 'chat-debug-page'; sessionId: string; beforeSeq: number }
  | { type: 'chat-debug-close'; sessionId: string }
  // A worker's expanded body (workers design D5): read the worker's on-disk
  // transcript live or after settle; the reply is chat-worker-transcript.
  | { type: 'chat-worker-transcript'; sessionId: string; workerId: string }
  // A background task's output tail (background tasks D3): at most the last
  // 8 KiB, live via the SDK or from the recorded output file after the
  // process ended; the reply is the chat-task-output server message.
  | { type: 'chat-task-output'; sessionId: string; taskId: string }
  // Stop one background task (background tasks D4): only that task ends; the
  // in-flight turn and other tasks are untouched. Settle arrives through the
  // normal roster channel, so there is no dedicated reply — a rejection for
  // an already-ended task is logged and dropped server-side.
  | { type: 'chat-task-stop'; sessionId: string; taskId: string }
  // Close an agent notice for its session on the server (notification strip
  // design D6): the manager drops the key and pushes the new list to every
  // attached client; unknown keys are a no-op. Account notices are closed
  // client-side only and never send this. Additive: existing clients never
  // send it.
  | { type: 'chat-dismiss-notification'; sessionId: string; key: string }
  // Workspace messages are additive; existing clients never send them.
  | { type: 'workspace-refresh'; projectPath?: string }
  | {
      type: 'create-worktree'
      repositoryId: string
      branch: string
      destination: string
      launchSession?: boolean
    }
  | {
      type: 'create-change-worktree'
      repositoryId: string
      change: string
    }
  | { type: 'ping'; seq?: number }

/** Diagnostic metadata attached to parsed ServerMessages by useWebSocket. */
export interface DiagnosticMeta {
  _parseMs: number
  _rawLength: number
}

/** A ServerMessage with diagnostic timing metadata from the WebSocket layer. */
export type ServerMessageWithDiagnostics = ServerMessage & DiagnosticMeta

// Typed function signatures for client-side messaging
export type SendClientMessage = (message: ClientMessage) => void
export type SubscribeServerMessage = (listener: (message: ServerMessage) => void) => () => void
