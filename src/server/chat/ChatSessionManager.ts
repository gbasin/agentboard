// Owns the lifecycle of chat sessions: auth-gated creation, lazy driver
// construction (the SDK query() is spawned by the driver on the first turn),
// persistence in the chat_sessions table with restore-on-start into the
// registry, kill/shutdown settlement (including the session's protocol log),
// immediate sdkSessionId capture so a restart can resume the same agent
// conversation, the current in-flight-turn activity (phase plus start
// time) surfaced through getSnapshot and the onActivity broadcast sink,
// the spawned-worker roster (rows plus outcomes) surfaced the same way
// through onWorkers and recovered from a sidecar on restart, and the
// notification strip's two sources (notification strip design D4/D5): agent
// notices held per session with same-key replacement and timeout expiry,
// merged ahead of the profile's account notice and surfaced through
// getSnapshot and the onNotifications broadcast sink. A
// live session's transcript is tailed for the agent's generated title rows,
// which replace any non-user-set name (chat-session-naming design D4). The
// SDK import stays dynamic (injected as a queryFactory in tests) so a broken
// install disables the feature instead of crashing the server. Chat spawns
// run a separately installed Claude Code executable: creation and every
// (re)spawn first pass an executable check (KAWAI_CLAUDE_PATH/PATH, version
// baseline) whose ClaudeExecutableError messages reach the user verbatim.
// Restore-on-start and attach history read transcripts asynchronously
// (async-transcript-parsing): whenRestored() resolves once every persisted
// row is registered, and the team mailbox starts only after that.
import os from 'node:os'
import type {
  ChatActivity,
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatCommandState,
  ChatContextUsage,
  ChatEvent,
  ChatNotification,
  ChatNotificationPriority,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatUsageReport,
  ChatWorker,
  ChatBackgroundTask,
} from '../../shared/chat'
import { EXHAUSTING_REASONS, turnSucceeded } from '../../shared/chat'
import type {
  ChatNameSource,
  ServerMessage,
  Session,
  SessionParkedState,
  SessionStatus,
} from '../../shared/types'
import type { ChatSessionRecord, SessionDatabase } from '../db'
import { generateSessionName } from '../nameGenerator'
import { existsSync } from 'node:fs'
import { isExistingDirectory, resolveProjectDirectory } from '../paths'
import type { SessionRegistry } from '../SessionRegistry'
import type { ChatQueryFactory } from './ChatSessionDriver'
import { createChatDriver, type ChatDriverSharedOptions } from './provider/createChatDriver'
import type { ChatAgentDriver, ChatRuntime } from './provider/driver'
import { chatAuthErrorMessage, hasClaudeAuth } from './chatAuth'
import { historyWindow } from './historyWindow'
import {
  ClaudeExecutableError,
  ensureClaudeExecutable,
  type ClaudeExecutableCheck,
} from './claudeExecutable'
import { effectiveChatEnv, type ChatProviderEnv } from './chatProviderEnv'
import type { ChatWireLogs } from './ChatWireLogs'
import type { ChatWorkerStore } from './chatWorkerStore'
import type { ChatTaskStore } from './chatTaskStore'
import {
  resolveClaudeProfile,
  profileCredential,
  profileLimitResetTimeZone,
  claudeLaunchKey,
  verifyProfileExecutable,
  withheldCredentialNamesAt,
  type ChatLaunchConfiguration,
  type ClaudeLaunchConfiguration,
  type ProfileCatalogContext,
} from './ClaudeProfiles'
import { RegisteredNameRefusal } from './secretNameRegistry'
import { logger } from '../logger'
import { probeSdkAvailability } from './sdkAvailability'
import { AccountNoticeStore, credentialsPathFor } from './accountNotices'
import { UsageLimitStore } from './usageLimits'
import { withTextReset } from './limitSignals'
import { providerOf } from './profileCatalog'
import { resolvedCatalog } from './catalogMemo'
import type { MergedProvider } from './catalogMerge'
import { ensureCodexExecutable } from './codex/codexExecutable'
import { codexLoginErrorMessage, hasCodexLogin } from './codex/codexAuth'
import { codexLimitProviderId } from './codex/codexLimits'
import { resolveCodexHome } from './codexProfiles'
import { fetchZaiUsage } from './zaiUsage'
import { fetchOpenRouterUsage, isOpenRouterBaseUrl, type OpenRouterUsagePull } from './openRouterUsage'
import { ambientProviderLabel, ambientProviderOf, catalogCtx } from '../team/cooldowns'
import { storedLoginKey } from '../team/routing/sharedLogins'
import { TeamCapacity } from '../team/teamCapacity'
import { readWorkerTranscript } from './chatWorkerTranscript'
import { isTaskOutputFile, readTaskOutputTail } from './taskOutputFile'
import type { BackgroundTaskRecord } from './chatBackgroundTasks'
import type { ExhaustionEpisode } from '../team/exhaustionNotes'
import { planAttentionFacts, planSummaryRows, type PlanAttentionFact, type PlanAttentionReads, type PlanSummaryRowReads, type PlanSummaryRows } from '../team/planAttention'
import { StallAlertStore } from '../plans/supervision/stallAlertStore'
import { loadTeamGroups } from '../team/teamGroups'
import { SessionTeams } from '../team/sessionTeams'
import { TeamScopes } from '../team/teamScope'
import { SessionDirectory } from '../team/sessionDirectory'
import { MessageFeed } from '../team/messageFeed'
import { MessageQuery } from '../team/messageQuery'
import { ChatTurnEndStore } from './chatTurnEndStore'
import { DriverMailGuard } from './driverMailGuard'
import { TeamMailbox } from '../team/TeamMailbox'
import { createMailboxServer, teamToolTable, type MailboxServerServices } from '../team/mailboxTools'
import { composeExecutionCore, composePlanServices } from '../plans/planComposition'
import type { ValidationService } from '../plans/validation/ValidationService'
import type { DecisionService } from '../plans/decisions/DecisionService'
import type { OpenspecAdapter } from '../plans/validation/openspecAdapter'
import type { ValidationDetailCache } from '../plans/validation/validationDetail'
import type { MailboxManagement } from '../team/mailboxManagement'
import { StrategyService } from '../strategy/StrategyService'
import { StrategyStore } from '../strategy/strategyStore'
import { PlanService } from '../plans/PlanService'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import type { TeamMessage, TeamWorktreeOccupancy, WaitingReason } from '../../shared/team'
import { MailDispatcher } from '../team/dispatcher'
import { codexReceiptMessageId, receiptMessageId, transcriptReceipt } from '../team/receipt'
import { codexRolloutReceipt } from '../team/codexReceipt'
import type { LimitEventStore } from '../team/routing/limitEvents'
import { sessionCooldown } from '../team/cooldowns'
import { supervisionRuntime } from '../plans/supervision/supervisionRuntime'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import type { HandoffTarget } from '../team/routing/limitOutcomes'
import type { RuleLoadReport, TeamRoutingState } from '../../shared/routing'
import { SessionMailbox, type ClaimRef } from '../team/sessionMailbox'
import type { TaskService } from '../team/TaskService'
import type { AssignmentService } from '../team/AssignmentService'
import type { TaskResultService } from '../team/TaskResultService'
import type { SpawnRequest, SpawnResult } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { worktreeRootOf } from '../team/worktreeRoots'
import { ProcessObservationService } from '../metrics/observations/service'
import { ProvenanceRecorder } from '../metrics/provenanceRecorder'
import { ChatTurnUsageStore, TurnUsageTracker } from './chatTurnUsageStore'
import { MetricsReader } from '../metrics/computeMetrics'
import { ProcessReportService, type ReportCaller } from '../metrics/reportService'
import type { ChatSpawnInfo } from './provider/driver'
import { OutboundDestinations } from '../outbound/destinations'
import { sessionObserver } from '../outbound/auditHooks'
import { RepoFactsResolver } from '../outbound/repoFacts'
import { OutboundService, recordingStore, type OutboundAuditBackups } from '../outbound/service'
import type { OutboundObserver } from '../outbound/observer'
import { OutboundStore } from '../outbound/store'
import {
  findTranscriptPath,
  findTranscriptPathAsync,
  replayTranscriptFile,
  replayTranscriptFileAsync,
  type TranscriptReplay,
} from './transcriptReplay'
import { canRetryCodexMemo, replayCodexRollout, replayCodexRolloutAsync } from './codex/codexRollout'
import { watchTranscriptTitle, type TranscriptTitleWatcher } from './transcriptTitleWatcher'
import { scanTranscriptMeta } from './transcriptMeta'
import { indexTranscripts, TranscriptPathCache } from './transcriptLocator'
import { resolveTeam } from '../team/teamIdentity'
import { validateWorkspaceSend } from './workspaceSendValidation'
import type { WorkspaceMessageContext, WorkspaceMessageEnvelope } from '../../shared/planWorkspace'

export type { ChatQueryFactory }
export { chatAuthErrorMessage, hasClaudeAuth }

export interface ChatSessionManagerOptions {
  registry: SessionRegistry
  db: SessionDatabase
  onMailboxChange?: (teamId: string, message?: TeamMessage) => void
  /** A team's waiting reasons structurally changed: re-publish its mailbox (team-waiting-reasons). */
  onWaitingReasonsChange?: (teamId: string) => void
  /** Routing rules (re)loaded: every mailbox view refreshes its rule status. */
  onRoutingRulesLoaded?: () => void
  /** Every committed team-task change (wired to the task view push in index.ts). */
  onTaskChange?: (teamId: string) => void
  /** Every committed strategy change (wired to the strategy view push in bootstrap.ts). */
  onStrategyChange?: (teamId: string) => void
  /** Every committed process report, decision, or link (team-process-metrics D6; wired to the Metrics tab push). */
  onProcessReportChange?: (teamId: string) => void
  /**
   * A chat session's record changed in a way a team view shows — created,
   * archived, restored, killed, or its status/name/group/task moved
   * (team-workspace: live membership). Wired to the workspace push; cheap
   * there because publishes coalesce per team.
   */
  onSessionRecordChange?: (sessionId: string) => void
  /**
   * Every committed plan write, and every change to a task linked to a plan
   * (wired to the Plans view push in bootstrap.ts); no plan id = every plan of
   * the team (a strategy or impact change moves every plan's impact gate).
   */
  onPlanChange?: (teamId: string, planId?: string) => void
  /**
   * Every committed audit call, outcome, or acknowledgement of the team
   * (execution-safety-recovery D9; wired to the Audit tab's
   * `team-audit-changed` push and the workspace's attention refresh).
   */
  onOutboundChange?: (teamId: string) => void
  /** The backup status footer's facts (database-safety); null when backups are off. */
  backupStatus?: () => OutboundAuditBackups | null
  /** Conversation-event sink (wired to the WS broadcast in index.ts). */
  onEvent: (sessionId: string, event: ChatEvent) => void
  /** Command-state sink (wired to the chat-commands push in index.ts). */
  onCommandState?: (sessionId: string, state: ChatCommandState) => void
  /**
   * Live-activity sink (activity indicator design D5): called on each phase
   * change of an in-flight turn, null when the turn ends. Wired to the WS
   * broadcast in index.ts; activity is ephemeral and never persisted.
   */
  onActivity?: (sessionId: string, activity: ChatActivity | null) => void
  /**
   * Context-usage sink (context meter design D5): called with the latest
   * reading whenever the driver publishes one, or null when a conversation
   * reset clears it. Wired to the coalesced WS broadcast in index.ts; the
   * reading itself persists at turn boundaries, compaction, driver death,
   * and the driver-flagged corrections.
   */
  onContextUsage?: (sessionId: string, usage: ChatContextUsage | null) => void
  /**
   * Model sink (chat-session-model design D5): called only when the driver
   * reports a model different from the last one. Wired to the coalesced WS
   * broadcast in index.ts; the value itself persists with the session row.
   */
  onModel?: (sessionId: string, model: string) => void
  /**
   * Plan-usage sink (usage bar design D4): called with the latest report
   * (or null) whenever a profile's held data changes. Wired to the WS
   * broadcast in index.ts; usage is ephemeral and never persisted.
   */
  /** The provider's latest plan report changed (providers-and-workers 5.1). */
  onUsage?: (providerId: string, report: ChatUsageReport | null) => void
  /**
   * Worker-roster sink (workers design D2): the full projection whenever a
   * live session's roster changes. Wired to the WS broadcast in index.ts;
   * ephemeral in transit, persisted through the sidecar (design D6).
   */
  onWorkers?: (sessionId: string, workers: ChatWorker[]) => void
  /**
   * Background-task roster sink (background tasks design D2): the full
   * projection whenever a live session's task roster changes. Wired to the
   * WS broadcast like onWorkers; ephemeral in transit, persisted through the
   * sidecar (design D6).
   */
  onBackgroundTasks?: (sessionId: string, tasks: ChatBackgroundTask[]) => void
  /**
   * Notification sink (notification strip design D5): the session's full
   * merged list (account notice first, then agent notices, sorted by
   * priority and newest) whenever either source changes for it. Wired to the
   * WS broadcast in index.ts; notices are ephemeral and never persisted.
   */
  onNotifications?: (sessionId: string, notifications: ChatNotification[]) => void
  /** Sidecar store for restart recovery of worker outcomes (design D6). */
  workerStore?: ChatWorkerStore
  /** Sidecar store for restart recovery of background-task outcomes (D6). */
  taskStore?: ChatTaskStore
  /** Injected in tests; production resolves the SDK via dynamic import. */
  queryFactory?: ChatQueryFactory
  /** Receives the provider env so it probes the endpoint sessions will use. */
  availabilityProbe?: (
    providerEnv: ChatProviderEnv,
    launch?: ClaudeLaunchConfiguration,
    executablePath?: string
  ) => Promise<void>
  /**
   * Resolves and verifies the Claude Code executable every spawn will run.
   * Injected in tests; the default checks KAWAI_CLAUDE_PATH/PATH (version
   * probe + baseline). An injected queryFactory (fake runtime) skips it.
   */
  executableCheck?: () => Promise<ClaudeExecutableCheck>
  authCheck?: () => boolean
  /**
   * Provider overrides for SDK spawns (base URL, models, gateway token). A
   * getter, so a Settings change reaches the next spawn without a restart.
   */
  getProviderEnv?: () => ChatProviderEnv
  /** Per-session protocol capture for the chat debug view (always on). */
  wireLogs?: ChatWireLogs
  /** Project-directory check; injected in tests that use fictitious paths. */
  isDirectory?: (path: string) => boolean
  /**
   * Home directory for the user-level `.kawai` catalogs (profiles.json and
   * groups/ live here). Injected in tests so a real home catalog cannot leak
   * in.
   */
  profileCatalogHome?: string
  /**
   * The saved question auto-answer wait in minutes (question-auto-answer D5),
   * read live so the next question after a change uses the new value while a
   * pending deadline stands (QA-S3, QA-S5, QA-P4). Claude drivers only: the
   * manager converts to milliseconds per question; Codex drivers never arm a
   * deadline (QA-U4), so this never reaches ChatDriverSharedOptions.
   */
  getQuestionAutoAnswerMinutes?: () => number
  /**
   * Injected in tests; production uses global fetch for the provider usage
   * pull (the session provider's own quota endpoint).
   */
  providerUsageFetch?: typeof fetch
  /** Provider usage refresh cadence (provider pull design D5); tests shrink it. */
  providerUsageRefreshMs?: number
  /**
   * Base delay between transcript-locate retries (chat-session-naming D4).
   * The locator runs until the session goes away — the transcript appears
   * with the first message, which can be much later than the SDK id. Tests
   * shrink it so a delayed transcript is cheap to cover.
   */
  titleLocateIntervalMs?: number
  /** Catalog file failure sink; defaults to the structured logger. */
  catalogErrorLog?: (errors: string[]) => void
  /**
   * Scoped workspace-discovery refresh (worktree tracking design D2): called
   * once per debounce window with the session's newest path after the agent
   * moved, so a newly entered worktree is discovered without a reload.
   * Wired to the workspace coordinator in index.ts.
   */
  requestWorkspaceRefresh?: (projectPath: string) => void
  /**
   * Canonical common git dirs of the discovered workspace repositories
   * (team-workspace-pages D1): a human team view may address any of them,
   * even with no chat in it. Wired to the workspace coordinator in
   * bootstrap.ts; absent means only chat sessions' teams are addressable.
   */
  workspaceRepositories?: () => readonly string[]
  /**
   * Debounce window for those refreshes (default 500ms): a fast cd chain
   * collapses into one discovery pass for its final directory.
   */
  cwdRefreshDebounceMs?: number
}

export type ChatCreateResult =
  | { ok: true; session: Session }
  | { ok: false; error: string }

export type ChatActionResult =
  | { ok: true }
  | { ok: false; error: string }

/** Send-time refusal for archived sessions; restoring clears it (design D2). */
const ARCHIVED_SESSION_ERROR =
  'This chat session is archived. Restore it to continue the conversation.'

/** The dynamic SDK import failed; surfaced by every spawn path. */
function sdkLoadError(error: unknown): string {
  if (error instanceof ClaudeExecutableError) {
    // Actionable by construction (names the path and the fix); the
    // record and its stored conversation id are untouched.
    return error.message
  }
  return (
    'The Claude Agent SDK could not be loaded, so chat sessions are unavailable. ' +
    `Check the @anthropic-ai/claude-agent-sdk install: ${
      error instanceof Error ? error.message : String(error)
    }`
  )
}

/** Strip display order (notification strip design D5): higher first. */
const NOTICE_PRIORITY_RANK: Record<ChatNotificationPriority, number> = {
  immediate: 3,
  high: 2,
  medium: 1,
  low: 0,
}

/** Priority first (immediate highest), then newest arrival (design D5). */
function compareNotices(a: ChatNotification, b: ChatNotification): number {
  const byPriority = NOTICE_PRIORITY_RANK[b.priority] - NOTICE_PRIORITY_RANK[a.priority]
  if (byPriority !== 0) return byPriority
  return Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
}

/** The chat-task-output reply payload (background tasks D3). */
export type ChatTaskOutputResult =
  | { state: 'ok'; output: string; totalBytes: number; truncated: boolean }
  | { state: 'unavailable' }

export class ChatSessionManager {
  private readonly options: ChatSessionManagerOptions
  private readonly records = new Map<string, ChatSessionRecord>()
  private readonly drivers = new Map<string, ChatAgentDriver>()
  /** In-flight ensureDriver calls, so racing sends never build two drivers. */
  private readonly driverPromises = new Map<
    string,
    Promise<ChatAgentDriver | null>
  >()
  private sdkQuery: Promise<ChatQueryFactory> | null = null
  /**
   * Current in-flight-turn activity per session: the phase body plus when it
   * began. Cleared on turn end, stop, archive, kill, and driver death; a
   * restart begins with none (design D5).
   */
  private readonly activities = new Map<
    string,
    { body: Omit<ChatActivity, 'elapsedMs'>; phaseStartedAt: number }
  >()
  /**
   * Latest context-usage reading per session (context meter design D5): the
   * fresher in-memory value between boundary writes; getSnapshot prefers it
   * over the stored column. Survives respawns; a restart begins with none.
   */
  private readonly contextReadings = new Map<string, ChatContextUsage>()
  /** Merged provider definitions per catalog stamp (host-login routing facts); re-resolved when the stamp moves. */
  /**
   * Latest worker roster per session (workers design D2): the last publish
   * of a live driver, or the recovered sidecar rows of a restarted one. A
   * live driver's projection is computed fresh for snapshots; this map is
   * what archived and restored sessions read.
   */
  private readonly workerRows = new Map<string, ChatWorker[]>()
  /**
   * Latest background-task roster per session (background tasks D2): the
   * last publish of a live driver, or the recovered sidecar rows of a
   * restarted one (design D6), mirroring the worker rows.
   */
  private readonly backgroundTaskRows = new Map<string, ChatBackgroundTask[]>()
  /**
   * Latest server-side task records per session (background tasks D6): the
   * rows plus the recorded output-file paths the wire shape never carries.
   * Recovery seeds the driver from these so the next roster write keeps the
   * paths; a live driver's records replace them wholesale on every publish.
   */
  private readonly backgroundTaskRecords = new Map<string, BackgroundTaskRecord[]>()
  /**
   * Availability probes for resolved provider configurations. Keyed so a provider
   * change in Settings re-probes the new endpoint; a failed probe is dropped so
   * a corrected configuration (or repaired install) recovers without a restart.
   * Concurrent creations under the same configuration share one probe.
   */
  private readonly availability = new Map<string, Promise<void>>()
  /**
   * Latest plan-usage report (or no-data verdict) per Claude profile, in
   * memory only (usage bar design D3): a restart begins with none.
   */
  private readonly usageLimits = new UsageLimitStore()
  /**
   * Profiles confirmed to serve the provider quota endpoint (provider usage
   * pull): their usage comes from there, and the host-login SDK pull is
   * skipped for the store lifetime. In memory only — a restart re-probes.
   */
  private readonly providerUsageProfiles = new Set<string>()
  /** Refresh timer per routed profile (provider usage pull design D5). */
  private readonly providerUsageTimers = new Map<string, ReturnType<typeof setInterval>>()
  /** Provider usage refresh cadence (provider usage pull design D5). */
  private readonly providerUsageRefreshMs: number
  /**
   * Balance-key values whose credits pull was already refused (openrouter
   * D6): each value logs once. Bounded — cleared when it grows past 64.
   */
  private readonly openrouterCreditsRefusals = new Set<string>()
  /** One-shot post-turn pull timer per provider (openrouter D6). */
  private readonly postTurnPullTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** When each provider's post-turn pull fired last, for the per-minute bound (openrouter D6). */
  private readonly postTurnPullFiredAt = new Map<string, number>()
  /**
   * Latest login-expiry notice per credentials path (notification strip
   * design D2), in memory only: a restart begins with none until a check
   * runs. Keyed by path, not profile id, so profiles sharing ~/.claude share
   * one check while a profile pointing elsewhere gets its own file.
   */
  private readonly accountNotices = new AccountNoticeStore()
  /**
   * Credentials path each session's account notice is computed from
   * (notification strip design D2): resolved from the session's effective
   * launch environment on attach and agent start; null when the environment
   * suppresses the stored-login check or the profile is unknown.
   */
  private readonly sessionCredentials = new Map<string, string | null>()
  /**
   * Active agent notices per session, by key (notification strip design D4):
   * a newer frame with the same key replaces its entry. Cleared whole on
   * archive, kill, restart, and shutdown — the notices die with the process
   * that emitted them.
   */
  private readonly agentNotices = new Map<string, Map<string, ChatNotification>>()
  /**
   * Pending timeout_ms expiry timers per session and notice key (design D4):
   * each removes only the entry it was armed for, and only if that entry is
   * still the same instance it was armed against.
   */
  private readonly agentNoticeTimers = new Map<
    string,
    Map<string, ReturnType<typeof setTimeout>>
  >()
  /**
   * Transcript title tails per live session (chat-session-naming design D4):
   * a handle is either an armed watcher or a pending locate retry, so exactly
   * one entry exists whenever a session's transcript is being followed.
   * Released on kill, archive, and shutdown.
   */
  private readonly titleWatchers = new Map<string, { close: () => void }>()
  /**
   * Pending debounced workspace refreshes (worktree tracking design D2): one
   * per session whose agent moved, firing with the newest path only. Cleared
   * on kill and shutdown; the callback itself cannot outlive the session.
   */
  private readonly cwdRefreshTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; path: string }
  >()

  async createAvailableSession(input: { projectPath: string; name?: string; claudeProfileId?: string; approvalPolicy?: ChatApprovalPolicy; groupId?: string; cloneFromSessionId?: string; taskId?: string; spawned?: boolean }): Promise<ChatCreateResult> {
    // Refuse a bad path before the probe spends an SDK spawn on it.
    const project = resolveProjectDirectory(input.projectPath, this.options.isDirectory)
    if (!project.ok) return project
    const clone = input.cloneFromSessionId ? this.records.get(input.cloneFromSessionId) : undefined
    if (input.cloneFromSessionId && (!clone || clone.projectPath !== project.path)) return { ok: false, error: 'Clone source must be an existing chat in this project' }
    if (clone) input = { ...input, groupId: clone.groupId ?? undefined }
    // Fresh group choices require a definition. A clone preserves the
    // source record's immutable role, including one whose file was removed.
    if (input.groupId !== undefined && !clone) {
      const { catalog } = await loadTeamGroups(project.path, this.options.profileCatalogHome)
      if (!catalog.groups.has(input.groupId)) {
        return { ok: false, error: `Unknown group "${input.groupId}" for this project's team` }
      }
    }
    let launch: ChatLaunchConfiguration
    try {
      launch = this.launchFor(input.claudeProfileId, project.path)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    // A Codex chat gates on the Codex executable and the resolved home's
    // login (codex-chat-sessions 4.2, spec scenarios "Codex missing", "Codex
    // below the baseline", "Not logged in"); the Claude SDK probe never
    // runs — it spends a Claude spawn that says nothing about Codex.
    if (launch.runtime === 'codex') {
      // An injected fake runtime (the development fixture) starts no Codex
      // child — the same seam checkExecutable applies to the Claude install —
      // unless the e2e carve-out configures a Codex executable.
      if (this.codexGatesApply()) {
        try {
          await ensureCodexExecutable()
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (!hasCodexLogin(launch.codexHome)) {
          return { ok: false, error: this.codexLoginRefusal(launch.codexHome, input.claudeProfileId ?? null) }
        }
      }
      return this.createSession(input)
    }
    const projectAuthRefusal = this.authRefusal(input.claudeProfileId, project.path)
    if (projectAuthRefusal) return { ok: false, error: projectAuthRefusal }
    try {
      await this.probeAvailability(input.claudeProfileId, project.path)
    } catch (error) {
      if (error instanceof ClaudeExecutableError) {
        // Actionable by construction (names the path and the fix).
        return { ok: false, error: error.message }
      }
      return {
        ok: false,
        error: 'Claude Agent SDK is unavailable. Check its installation, runtime, and chat provider settings, then try again. ' +
          (error instanceof Error ? error.message : 'SDK probe failed'),
      }
    }
    return this.createSession(input)
  }
  private readonly snapshotHistory = new Map<string, ChatEvent[]>()
  private readonly liveEvents = new Map<string, ChatEvent[]>()
  /**
   * Sessions whose memo is a Codex "history unavailable" notice (D8, M3):
   * the rollout may still appear, so the memo is retried on a later load —
   * but only while no live turn could be duplicated by the re-read.
   */
  private readonly retryableHistory = new Set<string>()
  /** In-flight async history loads, deduped per session (design D3). */
  private readonly historyLoads = new Map<string, Promise<void>>()
  /** Boot restore chain; chat-attach awaits it via whenRestored (design D2). */
  private readonly restorePromise: Promise<void>
  /**
   * SDK ids of persisted rows the async restore has not registered yet:
   * getSdkSessionIds reports them too, so log discovery never surfaces a
   * chat transcript as an extra session during the restore window.
   */
  private readonly restoringSdkIds = new Set<string>()
  /** Existing transcript per SDK id for the start blocker's check. */
  private readonly transcriptPaths = new TranscriptPathCache()
  private isShutDown = false

  /**
   * Synchronous capture: no driver callback can interleave with history
   * loading. `historyFrom` (chat-history-window D2) widens the recent
   * window to the unit holding that event id, so a reconnect covers the
   * span the client already showed; without it the window is the last 24
   * hours ending at the newest dated event, at least the newest turn.
   */
  getSnapshot(sessionId: string, options: { historyFrom?: string } = {}): Extract<ServerMessage, { type: 'chat-snapshot' }> | null {
    if (!this.records.has(sessionId)) return null
    // Attach (live or archived) is one of the account-notice check points
    // (notification strip design D3): resolve the session's credentials path
    // and read it before the snapshot freezes the notice list.
    this.refreshAccountNotice(sessionId)
    this.captureHistory(sessionId)
    const live = this.liveEvents.get(sessionId) ?? []
    const activity = this.getActivity(sessionId)
    // The recent history window (chat-history-window D1/D2): memo + live
    // cut to the last 24 hours. Only events are windowed — pending
    // requests, activity, rosters, notices and throughSequence stay whole.
    const window = historyWindow(
      [...(this.snapshotHistory.get(sessionId) ?? []), ...live],
      options.historyFrom !== undefined ? { fromId: options.historyFrom } : {}
    )
    return {
      type: 'chat-snapshot', sessionId,
      profileId: this.records.get(sessionId)?.claudeProfileId ?? 'default',
      events: this.attachWorkspaceContext(sessionId, window.events),
      pendingRequests: this.getPendingRequests(sessionId),
      status: this.options.registry.get(sessionId)?.status ?? 'waiting',
      // The live tail, not the window: older live events outside the window
      // stay behind it and a page must not replay them as new.
      throughSequence: live.at(-1)?.sequence ?? 0,
      // Older history on request, and where pages and reconnect resume.
      historyHasOlder: window.hasOlder,
      historyStartId: window.startId,
      commands: this.commandState(sessionId),
      activity,
      // In-memory wins: between boundary writes it is fresher than the
      // stored column (design D5).
      contextUsage:
        this.contextReadings.get(sessionId) ??
        this.records.get(sessionId)?.contextUsage ??
        null,
      // Stored with the row (design D4): applyPatch keeps the record current,
      // so this is the last reported model, null before the first one.
      model: this.records.get(sessionId)?.model ?? null,
      // The provider's plan report (providers-and-workers 5.1): sibling
      // models of one provider share the same plan usage.
      usage: this.usageLimits.get(this.providerIdOf(sessionId)),
      // The spawned-worker roster (workers design D2); live entries hold the
      // session at working, settled ones carry their persisted outcomes.
      workers: this.getWorkers(sessionId),
      // The background-task roster (background tasks D2): running tasks
      // fresh from the driver, settled ones from the last publish.
      backgroundTasks: this.getBackgroundTasks(sessionId),
      // The notification strip's merged list (design D5): account notice
      // first, then agent notices, sorted by priority and newest.
      notifications: this.notificationsOf(sessionId),
    }
  }

  /**
   * One history page (chat-history-window D2): the 24 hours before the
   * unit holding `beforeId`, at least one turn, widened back to `throughId`
   * (an event id or a `tool:<callId>` search anchor). `stale` with no
   * events means beforeId is not in the memo + live list. Never starts an
   * agent — archived chats page too; the caller awaits loadHistory first,
   * exactly as attach does.
   */
  getHistoryPage(sessionId: string, beforeId: string, throughId?: string): { events: ChatEvent[]; hasOlder: boolean; stale: boolean } | null {
    if (!this.records.has(sessionId)) return null
    this.captureHistory(sessionId)
    const window = historyWindow(
      [...(this.snapshotHistory.get(sessionId) ?? []), ...(this.liveEvents.get(sessionId) ?? [])],
      { beforeId, ...(throughId !== undefined ? { throughId } : {}) }
    )
    return { events: this.attachWorkspaceContext(sessionId, window.events), hasOlder: window.hasOlder, stale: window.stale === true }
  }

  /**
   * The session's roster: a live driver's fresh projection (elapsed times
   * computed now), the last publish for archived sessions, or the recovered
   * sidecar rows after a restart.
   */
  private getWorkers(sessionId: string): ChatWorker[] {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) return driver.getWorkers()
    return this.workerRows.get(sessionId) ?? []
  }

  /**
   * The session's background-task roster: a live driver's fresh projection,
   * else the last publish (or the recovered sidecar rows, design D6).
   */
  private getBackgroundTasks(sessionId: string): ChatBackgroundTask[] {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) return driver.getBackgroundTasks()
    return this.backgroundTaskRows.get(sessionId) ?? []
  }

  /**
   * Whether the session has a live background worker (member-release D3):
   * `idle` alone is only `status === 'waiting'`, and a worker keeps running
   * — and writing to the worktree — after the turn that started it ends.
   */
  hasLiveWorkers(sessionId: string): boolean {
    return this.getWorkers(sessionId).some(worker => worker.live)
  }

  /**
   * Whether the session has a running background task (member-release D3):
   * a `run_in_background` shell or Monitor keeps writing to the worktree
   * after its turn ends, and archiving would end it. Process end settles
   * every running entry as stopped, so a dead agent never holds this.
   */
  hasRunningBackgroundTasks(sessionId: string): boolean {
    return this.getBackgroundTasks(sessionId).some(task => task.status === 'running')
  }

  /**
   * A session's worker or background-task roster changed. A pending
   * release's readiness includes both (member-release D3): a change on a
   * pending member re-runs the dispatch cycle (D2), since no status change
   * follows a worker or task that ends while the session is already idle.
   */
  private rosterChanged(sessionId: string): void {
    if (this.teamMail.releases.pendingFor(sessionId)) this.dispatcher.notify()
  }

  /** Current activity with a live-computed elapsed time, or null when idle. */
  private getActivity(sessionId: string): ChatActivity | null {
    const entry = this.activities.get(sessionId)
    if (!entry) return null
    return { ...entry.body, elapsedMs: Math.max(0, Date.now() - entry.phaseStartedAt) }
  }

  /**
   * A worker's expanded body (workers design D5), read from the on-disk
   * subagent transcript. Works live and after settle; unavailable (never an
   * error) when the worker or its file cannot be found.
   */
  getWorkerTranscript(
    sessionId: string,
    workerId: string
  ): { status: 'ok' | 'unavailable'; events: ChatEvent[] } {
    return readWorkerTranscript(
      this.records.get(sessionId)?.sdkSessionId ?? null,
      workerId
    )
  }

  // ------------------------------------------------------- background tasks

  /** In-flight output reads, so concurrent requests coalesce (design D3). */
  private readonly taskOutputReads = new Map<string, Promise<ChatTaskOutputResult>>()

  /**
   * A background task's output tail (background tasks D3): the live query's
   * `get_task_output` while it answers, else the last 8 KiB of the recorded
   * output file, else `unavailable` — never an error. Concurrent reads for
   * the same task share one request.
   */
  readTaskOutput(sessionId: string, taskId: string): Promise<ChatTaskOutputResult> {
    const key = `${sessionId}:${taskId}`
    const inFlight = this.taskOutputReads.get(key)
    if (inFlight) return inFlight
    const read = this.readTaskOutputOnce(sessionId, taskId).finally(() => {
      this.taskOutputReads.delete(key)
    })
    this.taskOutputReads.set(key, read)
    return read
  }

  private async readTaskOutputOnce(sessionId: string, taskId: string): Promise<ChatTaskOutputResult> {
    const driver = this.drivers.get(sessionId)
    if (driver && !driver.isDead) {
      const live = await driver.getTaskOutput(taskId)
      if (live && typeof live.output === 'string') {
        return {
          state: 'ok',
          output: live.output,
          totalBytes: live.total_bytes,
          truncated: live.truncated === true,
        }
      }
    }
    // The process is gone (or predates the control request): the sidecar's
    // recorded output file answers instead, while it still exists.
    const record = this.options.taskStore
      ?.read(sessionId)
      .find((entry) => entry.taskId === taskId)
    const file = record?.outputFile
    if (file !== undefined && isTaskOutputFile(file, taskId)) {
      const tail = readTaskOutputTail(file)
      if (tail) return { state: 'ok', ...tail }
    }
    return { state: 'unavailable' }
  }

  /**
   * Stop one background task (background tasks D4): accepted only for a
   * live, non-archived session and a task the roster knows as live. The
   * settle arrives as a normal notification through the roster channel, so
   * there is no reply; a refusal (already ended, unknown, archived) is
   * logged and dropped, never a transcript error.
   */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    const record = this.records.get(sessionId)
    if (!record || record.archivedAt) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'not_live' })
      return
    }
    const live = this.getBackgroundTasks(sessionId).some(
      (task) => task.taskId === taskId && task.live
    )
    if (!live) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'not_live_task' })
      return
    }
    const driver = this.drivers.get(sessionId)
    if (!driver || driver.isDead) {
      logger.warn('chat_task_stop_refused', { sessionId, taskId, reason: 'no_driver' })
      return
    }
    const stopped = await driver.stopTask(taskId)
    if (!stopped) logger.warn('chat_task_stop_rejected', { sessionId, taskId })
  }

  // ---------------------------------------------------------------- notifications

  /**
   * The session's merged notice list (notification strip design D5): its
   * profile's account notice followed by its own agent notices, the whole
   * list sorted by priority and newest — a stable sort keeps the account
   * notice ahead of same-priority agent notices.
   */
  private notificationsOf(sessionId: string): ChatNotification[] {
    const credentials = this.sessionCredentials.get(sessionId)
    const account = credentials ? this.accountNotices.get(credentials) : null
    const agents = [...(this.agentNotices.get(sessionId)?.values() ?? [])]
    return [account, ...agents]
      .filter((notice): notice is ChatNotification => notice !== null)
      .sort(compareNotices)
  }

  /** Push the session's current merged list to the notification sink. */
  private emitNotifications(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    this.options.onNotifications?.(sessionId, this.notificationsOf(sessionId))
  }

  /**
   * Resolve a session's credentials path from its effective launch
   * environment and re-check the stored login (notification strip design
   * D2/D3). An unresolvable profile (launchFor throws) maps to null: no
   * notice, never an error — snapshots must not fail on a bad profile.
   */
  private refreshAccountNotice(sessionId: string): void {
    const record = this.records.get(sessionId)
    if (!record) return
    let credentialsPath: string | null = null
    try {
      // A credentialed provider's session does not use the host login, so
      // its expiry is not this session's notice (openrouter-provider D4).
      credentialsPath = profileCredential(record.claudeProfileId, this.catalogCtx(record.projectPath))
        ? null
        : credentialsPathFor(this.launchEnvOf(record.claudeProfileId, record.projectPath))
    } catch {
      credentialsPath = null
    }
    this.sessionCredentials.set(sessionId, credentialsPath)
    if (credentialsPath) this.accountNotices.check(credentialsPath)
  }

  /**
   * Re-check account notices for the given sessions' credentials paths (the
   * slow-timer check point of design D3). Change-only: unchanged results
   * publish nothing, so an idle timer is a handful of file reads.
   */
  recheckAccountNotices(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) {
      if (this.records.has(sessionId)) this.refreshAccountNotice(sessionId)
    }
  }

  /**
   * Hold an agent-emitted notice (notification strip design D4): same-key
   * replacement by the newer instance, an optional timeout_ms expiry, and a
   * fan-out of the merged list. One session's notices never leak into
   * another — the map is keyed by the emitting session.
   */
  private handleDriverNotification(
    sessionId: string,
    notification: ChatNotification,
    timeoutMs?: number
  ): void {
    if (!this.records.has(sessionId)) return
    const notices = this.agentNotices.get(sessionId) ?? new Map<string, ChatNotification>()
    notices.set(notification.key, notification)
    this.agentNotices.set(sessionId, notices)
    this.armNoticeTimer(sessionId, notification, timeoutMs)
    this.emitNotifications(sessionId)
  }

  /**
   * (Re)arm a notice's expiry timer: a replacement clears the old timer, and
   * only arms a new one when the frame carried a usable timeout. The armed
   * timer removes its entry only if that entry is still the same instance
   * (compared by receivedAt) — a replacement must not be expired by its
   * predecessor's clock.
   */
  private armNoticeTimer(
    sessionId: string,
    notification: ChatNotification,
    timeoutMs?: number
  ): void {
    const timers =
      this.agentNoticeTimers.get(sessionId) ?? new Map<string, ReturnType<typeof setTimeout>>()
    const existing = timers.get(notification.key)
    if (existing) clearTimeout(existing)
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timers.delete(notification.key)
    } else {
      const timer = setTimeout(() => {
        timers.delete(notification.key)
        const notices = this.agentNotices.get(sessionId)
        const current = notices?.get(notification.key)
        if (current && current.receivedAt === notification.receivedAt) {
          notices!.delete(notification.key)
          this.emitNotifications(sessionId)
        }
      }, timeoutMs)
      timer.unref?.()
      timers.set(notification.key, timer)
    }
    this.agentNoticeTimers.set(sessionId, timers)
  }

  /**
   * Drop every agent notice and timer of a session (design D4): the notices
   * die with the agent process that emitted them — archive, kill, restart,
   * shutdown, and an unexpected exit (the driver's onProcessEnd, whose
   * internal respawn would otherwise inherit them). `emit` pushes the now
   * account-only list to subscribers (archive, unexpected exit); kill and
   * shutdown have no one left to tell.
   */
  private clearAgentNotices(sessionId: string, options?: { emit?: boolean }): void {
    for (const timer of this.agentNoticeTimers.get(sessionId)?.values() ?? []) {
      clearTimeout(timer)
    }
    this.agentNoticeTimers.delete(sessionId)
    const had = this.agentNotices.delete(sessionId)
    if (had && options?.emit) this.emitNotifications(sessionId)
  }

  /**
   * Close an agent notice for its session (notification strip design D6):
   * removes the key everywhere (the push reaches every attached client) and
   * pushes the new list. Unknown keys — and account keys, which close
   * client-side only — are a no-op.
   */
  dismissNotification(sessionId: string, key: string): ChatActionResult {
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const notices = this.agentNotices.get(sessionId)
    if (!notices?.has(key)) return { ok: true }
    const timers = this.agentNoticeTimers.get(sessionId)
    const timer = timers?.get(key)
    if (timer) clearTimeout(timer)
    timers?.delete(key)
    notices.delete(key)
    this.emitNotifications(sessionId)
    return { ok: true }
  }

  private captureHistory(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    if (this.snapshotHistory.has(sessionId)) {
      if (!this.canRetryCodexHistory(sessionId)) return
      this.snapshotHistory.delete(sessionId)
      this.retryableHistory.delete(sessionId)
    }
    const record = this.records.get(sessionId)!
    // Every caller awaits loadHistory first, so reaching the file here means
    // one skipped the await and read the history synchronously
    // (bounded-history-capture D1): logged so the caller shows up.
    logger.debug('chat_history_sync_capture', { sessionId, runtime: record.runtime ?? 'claude' })
    const replay = this.getHistory(sessionId)
    this.snapshotHistory.set(sessionId, replay?.events ?? [])
    if (record.runtime === 'codex' && replay && replay.status !== 'ok') this.retryableHistory.add(sessionId)
  }

  /**
   * Whether a retryable Codex history memo may be dropped for a retry now
   * (D8, M3): only while `liveEvents` is empty. The memo is taken before a
   * driver start, so everything the agent appends afterwards is also in
   * `liveEvents`; a re-read after live turns began would replay those same
   * turns and duplicate them. The retry therefore waits for a load with no
   * live events (before the first turn, or after a restart).
   */
  private canRetryCodexHistory(sessionId: string): boolean {
    return canRetryCodexMemo(this.retryableHistory.has(sessionId), (this.liveEvents.get(sessionId) ?? []).length)
  }

  /**
   * Load a session's transcript history off the event loop
   * (async-transcript-parsing design D3): populates the snapshot-history
   * memo once via the async replay; concurrent attaches share a single
   * load. Kill during a load is safe: the row is re-checked after the
   * awaits, so a killed session's memo is never (re-)written.
   *
   * Memo audit (design D3/D4): the memo IS `snapshotHistory`, and it is not
   * invalidated on turn completion. The memo is taken before every driver
   * start (attach, send, start, mailbox prepare), so everything the agent
   * appends to the transcript afterwards is also in `liveEvents`; snapshots
   * are memo + live events, and re-reading the transcript at a turn boundary
   * would duplicate those turns. Only kill drops the memo (with the live
   * events). Every driver start — send, start, and the mailbox's prepare —
   * awaits this load (bounded-history-capture D1); the synchronous
   * captureHistory stays only as a guard in getSnapshot and getHistoryPage,
   * whose callers await this load first, and logs a debug line if it ever
   * reads the file. A capture that wins the race keeps its result; this
   * load then discards its own.
   */
  async loadHistory(sessionId: string): Promise<void> {
    if (!this.records.has(sessionId)) return
    if (this.snapshotHistory.has(sessionId) && !this.canRetryCodexHistory(sessionId)) return
    const inFlight = this.historyLoads.get(sessionId)
    if (inFlight) return inFlight
    const load = (async () => {
      const record = this.records.get(sessionId)
      if (!record) return
      if (this.snapshotHistory.has(sessionId) && !this.canRetryCodexHistory(sessionId)) return
      if (this.snapshotHistory.has(sessionId)) {
        // A retryable Codex notice memo: drop it for this load's retry. The
        // guard above held it while live events existed (D8, M3).
        this.snapshotHistory.delete(sessionId)
        this.retryableHistory.delete(sessionId)
      }
      if (record.runtime === 'codex') {
        // A Codex chat's transcript is the rollout its start reported
        // (codex-chat-sessions D8, M3) — the one replay source, never a
        // Claude `<id>.jsonl`. A chat that never started has no rollout and
        // replays as empty, like a Claude session without an SDK id.
        if (!record.sdkSessionId && !record.transcriptPath) {
          if (this.records.has(sessionId) && !this.snapshotHistory.has(sessionId)) {
            this.snapshotHistory.set(sessionId, [])
          }
          return
        }
        const replay = await replayCodexRolloutAsync(record.transcriptPath)
        if (this.records.has(sessionId) && !this.snapshotHistory.has(sessionId)) {
          this.snapshotHistory.set(sessionId, replay.events)
          if (replay.status !== 'ok') this.retryableHistory.add(sessionId)
        }
      } else if (record.sdkSessionId) {
        const replay = await replayTranscriptFileAsync(
          await findTranscriptPathAsync(record.sdkSessionId),
          { excludeToolCallIds: this.liveToolCallIds(sessionId) }
        )
        // The transcript's last cwd is where the conversation actually is
        // (worktree tracking design D3) — the same catch-up getHistory applies.
        if (this.records.has(sessionId) && !this.snapshotHistory.has(sessionId)) {
          if (replay.cwd) this.handleDriverCwdChanged(sessionId, replay.cwd)
          this.snapshotHistory.set(sessionId, replay.events)
        }
      } else if (this.records.has(sessionId)) {
        // Sessions that never started have no SDK id and replay as empty.
        this.snapshotHistory.set(sessionId, [])
      }
    })().finally(() => {
      this.historyLoads.delete(sessionId)
    })
    this.historyLoads.set(sessionId, load)
    return load
  }

  /**
   * The session's command state for snapshots: a live driver's tracker, or
   * unavailable when no process can be asked (never started, blocked, dead,
   * archived — design D3: the client needs no special case).
   */
  private commandState(sessionId: string): ChatCommandState {
    const driver = this.drivers.get(sessionId)
    return driver && !driver.isDead
      ? driver.getCommandState()
      : { status: 'unavailable', commands: [] }
  }

  constructor(options: ChatSessionManagerOptions) {
    this.options = options
    this.directory = new SessionDirectory(options.db.db)
    this.providerUsageRefreshMs = options.providerUsageRefreshMs ?? 10 * 60 * 1000
    // Outbound audit (execution-safety-recovery D3/D6): one store and one
    // repository-facts resolver for every session; observers are per session.
    this.outboundStore = new OutboundStore(options.db.db)
    this.outboundRepoFacts = new RepoFactsResolver()
    this.outboundObservers = new Map()
    // The audit view's reads and the owner's acknowledge (D9/D10): rows are
    // enriched with the live records and the durable directory, and every
    // committed row notifies the team's views through onOutboundChange.
    this.outboundAudit = new OutboundService({
      store: this.outboundStore,
      sessionOf: (teamId, sessionId) => {
        const record = this.records.get(sessionId)
        if (record) return { name: record.name, clickable: true }
        // A killed session keeps its recorded name and never a link (D9).
        const gone = this.directory.get(teamId, sessionId)
        return gone
          ? { name: `${gone.name} (gone)`, clickable: false }
          : { name: sessionId, clickable: false }
      },
      spawnLive: (sessionId, spawnId) => this.outboundObservers.get(sessionId)?.spawnIsLive(spawnId) ?? false,
      ...(options.backupStatus ? { backups: options.backupStatus } : {}),
      onCommit: teamId => options.onOutboundChange?.(teamId),
    })
    // Outbound destinations (execution-safety-recovery D2): the security
    // note's facts come from here at each spawn; the global provider env's
    // base URL rides along as a model provider every profile may inherit.
    this.outbound = new OutboundDestinations({
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
      onErrors: errors => logger.warn('outbound_destinations_errors', { errors }),
      globalBaseUrl: () => this.providerEnv().ANTHROPIC_BASE_URL,
    })
    // Team membership (agent-teams D6) resolves asynchronously; once a
    // session's team is known its group label/missing state is published.
    this.teams = new SessionTeams({
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
      outbound: this.outbound,
      onResolved: (sessionId) => {
        this.dispatcher?.notify()
        const record = this.records.get(sessionId)
        // The directory keys by team, so it can only record once the team is known.
        if (record) this.syncDirectory(sessionId)
        // A session's team landing (creation, or a cwd move) is membership a
        // team view shows (team-workspace); the team is resolvable from here on.
        this.options.onSessionRecordChange?.(sessionId)
        // Group-less sessions have nothing to show; skip the broadcast.
        if (record?.groupId != null) {
          this.options.registry.updateSession(sessionId, this.groupFields(record))
        }
      },
    })
    this.teamScopes = new TeamScopes({
      teams: this.teams,
      repositories: () => options.workspaceRepositories?.() ?? [],
    })
    // Provider usage changes drive the chat-usage broadcast (design D4,
    // providers-and-workers 5.1).
    this.usageLimits.subscribe((providerId, report) =>
      this.options.onUsage?.(providerId, report)
    )
    // An account-notice change fans out to every session mapped to that
    // credentials path (notification strip design D5).
    this.accountNotices.subscribe((credentialsPath) => {
      for (const [sessionId, path] of this.sessionCredentials) {
        if (path === credentialsPath) this.emitNotifications(sessionId)
      }
    })
    // The execution core exists before the team services: they take the
    // ownership it mints (plan-execution D7), and the composition below
    // reuses its store and wake hub (one ExecutionStore per server).
    this.executionCore = composeExecutionCore(options.db.db)
    const executionCore = this.executionCore
    // One reader of `~/.kawai/teams.json` (N5): spawn caps for the mailbox
    // and the plan-execution settings for the composition below.
    this.caps = new TeamCaps({
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
      onErrors: errors => logger.warn('team_caps_file_errors', { errors }),
    })
    this.teamMail = new SessionMailbox(options.db.db, {
      teams: this.teams, records: () => this.records.values(), getRecord: id => this.records.get(id),
      getDriver: id => this.drivers.get(id), homeDir: options.profileCatalogHome,
      available: record => record.archivedAt == null && !this.startBlocker(record) && (options.isDirectory ?? isExistingDirectory)(record.projectPath),
      // The same refusal text `available` rejects on, read-only (team-waiting-reasons D2).
      startBlocker: record => this.startBlockerFor(record),
      prepare: async id => { await this.loadHistory(id); const driver = await this.ensureDriver(id); if (!driver) throw new Error('Recipient disappeared'); driver.start() },
      restore: id => { const result = this.restore(id); if (!result.ok) throw new Error(result.error) },
      watchReceipt: id => this.watchSessionTitle(id),
      archive: id => this.archive(id),
      hasLiveWorkers: id => this.hasLiveWorkers(id),
      hasRunningBackgroundTasks: id => this.hasRunningBackgroundTasks(id),
      spawn: request => this.spawnMember(request),
      caps: this.caps,
      // A spawned member keeps the task it was spawned for; others follow
      // the task of the mail they received last.
      associateTask: (id, taskId) => {
        const record = this.records.get(id)
        if (record && !record.spawned && record.taskId !== taskId) this.applyPatch(id, { taskId })
      },
      // Sync discovery is fine here: a per-event lookup, not the boot path
      // (async-transcript-parsing design D4).
      transcriptFor: id => this.receiptTranscript(id),
      // A Codex chat's receipts are its rollouts' user messages (D8), read
      // over every rollout file of its thread (PR D decision 2, M1–M2).
      receiptFor: (id, messageId) => {
        const record = this.records.get(id)
        return record?.runtime === 'codex'
          ? codexRolloutReceipt({ transcriptPath: record.transcriptPath, codexHome: record.codexHome, threadId: record.sdkSessionId }, messageId)
          : transcriptReceipt(this.receiptTranscript(id), messageId)
      },
      onChange: options.onMailboxChange,
      onReasonsChange: options.onWaitingReasonsChange,
      // The router reads the profile's provider plan report (D14: a profile
      // state's usage is its provider's), and the provider view reads its
      // report by provider id — never re-mapped as a profile id, which a
      // model key of another provider would be.
      usageOf: profileId =>
        this.usageLimits.get(ambientProviderOf(options.profileCatalogHome)(profileId)),
      providerUsageOf: providerId => this.usageLimits.get(providerId),
      onRulesLoaded: () => options.onRoutingRulesLoaded?.(),
      onError: error => logger.warn('team_mailbox_dispatch_failed', { error: String(error) }),
      ownership: executionCore.ownership,
      onTaskResultWrite: taskId => executionCore.wakes.resultWrite(taskId),
      // A settled check changes what the task detail reads (independent-
      // verification D12): the human's open views refresh like on a task write.
      onCheckSettled: teamId => options.onTaskChange?.(teamId),
    })
    this.mailbox = this.teamMail.mailbox
    this.tasks = this.teamMail.tasks
    this.management = this.teamMail.management
    this.assignments = this.teamMail.assignments
    this.results = this.teamMail.results
    this.messages = new MessageFeed(this.mailbox.store, new MessageQuery(options.db.db))
    // Written from the event path below, independent of any open view; the
    // workspace summary reads its window from this table (team-workspace D8).
    this.turnEnds = new ChatTurnEndStore(options.db.db)
    this.provenance = new ProvenanceRecorder(options.db.db)
    this.turnUsage = new ChatTurnUsageStore(options.db.db)
    this.metrics = new MetricsReader(options.db.db, Date.now,
      // The provider cooldown (providers-and-workers D8) resolves in the
      // team's own catalog, so a provider event shows in every profile's tax.
      (profileId, teamId) => providerOf(profileId, this.catalogCtx(teamId)))
    // team_capacity (dispatch-worker-choice D6) reads the router's own objects:
    // the members counter, staffing's reservations, the limit store, the
    // ambient provider resolution, and the provider-keyed usage store.
    this.capacity = new TeamCapacity({
      teams: this.teams, records: () => this.records.values(),
      pendingSpawns: teamId => this.teamMail.staffing.pendingFor(teamId),
      limits: this.teamMail.limits,
      providerOf: ambientProviderOf(options.profileCatalogHome),
      providerLabel: ambientProviderLabel(options.profileCatalogHome),
      providerUsageOf: providerId => this.usageLimits.get(providerId),
      loginKeyOf: (profileId, groupsRoot) => this.loginKeyOf(profileId, groupsRoot),
    })
    this.reports = new ProcessReportService(options.db.db, this.metrics, {
      onCommit: teamId => this.options.onProcessReportChange?.(teamId),
    })
    this.turnUsageTracker = new TurnUsageTracker(this.turnUsage, {
      sessionTask: id => this.records.get(id)?.taskId ?? null,
      latestStart: id => this.provenance.latestStart(id),
      context: id => {
        const record = this.records.get(id)
        return {
          teamId: this.teams.teamOf(id)?.teamId ?? null,
          groupId: record?.groupId ?? null,
          profileId: record?.claudeProfileId ?? 'default',
          model: record?.model ?? null,
        }
      },
    })
    this.observations = new ProcessObservationService(options.db.db, id => {
      const record = this.records.get(id)
      const startId = this.provenance.latestStart(id)
      const start = startId
        ? options.db.db.prepare('SELECT model FROM agent_starts WHERE id=?').get(startId) as { model: string | null } | null
        : null
      return {
        sessionId: id, teamId: this.teams.teamOf(id)?.teamId ?? null,
        taskId: record?.taskId ?? null,
        taskRevision: record?.taskId ? this.tasks.store.get(record.taskId)?.revision ?? null : null,
        groupId: record?.groupId ?? null, profileId: record?.claudeProfileId ?? 'default',
        model: start?.model ?? record?.model ?? null, startId,
      }
    })
    this.observations.start([
      notify => this.tasks.store.subscribe(task => notify(task.id)),
      notify => this.mailbox.store.subscribe((_team, message) => notify(message?.taskId ?? undefined)),
      notify => this.teamMail.limits.subscribe(() => notify()),
    ])
    // Product strategy (product-strategy): constructed here, beside the
    // task service, against the same database. The strategy store's changes
    // fan out to the strategy view pushes; the team comes from the record's
    // team binding (design D5).
    this.strategies = new StrategyService(new StrategyStore(options.db.db), {
      getSession: id => this.records.get(id),
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
    })
    // Strategy impact (strategy-revision-impact): the owner's decisions over
    // the same database; its gate is approval's `pinDisposition` (contract C-I1).
    this.impact = new ImpactService(new ImpactStore(options.db.db), {
      strategies: this.strategies.store,
      plans: this.teamMail.plans,
      mail: this.mailbox.store,
      getSession: id => this.records.get(id),
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
    })
    // Plans and their validation (durable-plans + plan-validation), composed
    // the one way anything may compose them: the ValidationService over the
    // same plan store, capacity evidence from staffing and the limit events
    // through the team's own groups root, and the PlanService with
    // validation's `validation-current` appended after the shipped approval
    // preconditions.
    const planServices = composePlanServices({
      db: options.db.db,
      plans: this.teamMail.plans,
      strategies: this.strategies.store,
      impact: this.impact,
      getSession: id => this.records.get(id),
      capacityReads: {
        capacity: (teamId, group, worktree) => this.teamMail.staffing.capacity(teamId, group, worktree),
        // The profile's effective cooldown (providers-and-workers D8) in the ambient catalog.
        cooldownUntil: profileId => this.teamMail.limits.cooldownFor(profileId, providerOf(profileId, this.catalogCtx())).until,
      },
      caps: this.caps,
      executionCore,
      executionTeam: {
        tasks: this.teamMail.tasks,
        assignments: this.teamMail.assignments,
        results: this.teamMail.results,
        taskStore: this.teamMail.tasks.store,
        mailbox: this.teamMail.mailbox.store,
        teamMailbox: this.teamMail.mailbox,
        releases: this.teamMail.releases,
        pendingSpawns: teamId => this.teamMail.staffing.pendingFor(teamId),
        records: () => this.records.values(),
        // The executor resolves teams by id (a member-less team included);
        // the runtime's archive wake resolves sessions.
        identityOf: teamId => this.teams.identityFor(teamId),
        teamOfSession: id => this.teams.teamOf(id),
        // The supervision detail's runtime facts (plan-supervision D10).
        supervision: supervisionRuntime({
          db: options.db.db, mail: this.teamMail.mailbox.store, getRecord: id => this.records.get(id),
          pendingRequests: id => this.drivers.get(id)?.getPendingRequests() ?? [],
          hasLiveWorkers: id => this.hasLiveWorkers(id), hasRunningBackgroundTasks: id => this.hasRunningBackgroundTasks(id),
          waitingFor: teamId => this.teamMail.waitingFor(teamId),
          cooldownUntil: record => sessionCooldown(this.teamMail.limits, options.profileCatalogHome, record.claudeProfileId ?? 'default', record.projectPath).until,
        }),
        // The pause tick's holder facts (revision-control D8), from the same reads.
        pauseFacts: pauseHolderFacts({
          getRecord: id => this.records.get(id),
          pendingRequest: id => (this.drivers.get(id)?.getPendingRequests().length ?? 0) > 0,
          hasLiveWorkers: id => this.hasLiveWorkers(id), hasRunningBackgroundTasks: id => this.hasRunningBackgroundTasks(id),
          parkedResumes: id => this.teamMail.mailbox.store.parkedBy(id).map(row => row.parkedUntil),
          cooldownUntil: record => sessionCooldown(this.teamMail.limits, options.profileCatalogHome, record.claudeProfileId ?? 'default', record.projectPath).until,
        }),
      },
      ...(options.profileCatalogHome ? { homeDir: options.profileCatalogHome } : {}),
    })
    this.validation = planServices.validation
    this.decisions = planServices.decisions
    this.plans = planServices.plans
    this.planWorkspace = planServices.workspaceStore
    this.planWorkspaceRefs = planServices.workspaceRefs
    this.planWorkspaceContext = planServices.workspaceContext
    this.planWorkspaceRuntimeReads = planServices.supervisionReads
    this.planExecutionStore = planServices.executionStore
    this.executions = planServices.executions
    this.executionRuntime = planServices.runtime
    this.supervisionMonitor = planServices.monitor
    this.promotions = planServices.promotions
    this.checkpoints = planServices.checkpoints
    this.validationDetail = planServices.validationDetail
    this.validationAdapter = planServices.adapter
    // The plan attention's gatherer reads (plan-supervision D13): the same
    // supervision reads the monitor sweeps over, plus the promotion listing.
    this.planAttentionReads = planServices.supervisionReads === null ? null
      : { ...planServices.supervisionReads, promotions: planServices.integrationStore }
    // The summary's window reads (plan-supervision D13): durable stores only.
    this.planSummaryReads = planServices.supervisionReads === null ? null : {
      plans: planServices.plans.store,
      executions: planServices.executionStore,
      decisions: planServices.supervisionReads.decisions,
      alerts: new StallAlertStore(options.db.db),
    }
    // The impact assessment derives from plans, and every plan's impact gate
    // from the strategy and the impact records (strategy-revision-impact D9):
    // each of the three stores refreshes both views of its team.
    const strategyTeam = (strategy: { repoBindings: Array<{ kind: string; root: string }> } | null) =>
      strategy?.repoBindings.find(binding => binding.kind === 'team')?.root
    this.plans.store.subscribe(plan => {
      this.options.onPlanChange?.(plan.teamId, plan.id)
      this.options.onStrategyChange?.(plan.teamId)
    })
    // Every committed execution write re-pushes the plan's detail (D17):
    // the changes carry the execution's view, and owned-task changes ride
    // the task store's own plan flow above.
    planServices.executionStore.subscribe(teamId => {
      this.options.onPlanChange?.(teamId)
    })
    // Every candidate, promotion, or promotion-effect write re-pushes the plan's detail (integration-candidates D13).
    planServices.integrationStore.subscribe((teamId, planId) => this.options.onPlanChange?.(teamId, planId))
    this.strategies.store.subscribe(strategy => {
      const teamId = strategyTeam(strategy)
      if (!teamId) return
      this.options.onStrategyChange?.(teamId)
      this.options.onPlanChange?.(teamId)
    })
    this.impact.store.subscribe(strategyId => {
      const teamId = strategyTeam(this.strategies.store.get(strategyId))
      if (!teamId) return
      this.options.onStrategyChange?.(teamId)
      this.options.onPlanChange?.(teamId)
    })
    // A retitled task re-labels the headers of the sessions working on it.
    this.tasks.store.subscribe(task => {
      this.options.onTaskChange?.(task.teamId)
      // A linked task's change moves its plan's progress (durable-plans D12).
      if (task.planId) this.options.onPlanChange?.(task.teamId, task.planId)
      for (const record of this.records.values()) {
        if (record.taskId === task.id) this.options.registry.updateSession(record.sessionId, this.taskFields(record))
      }
    })
    // A draft save refreshes the human's task view only (task-revision-publication
    // D1): never a task change, so nothing above or in the mailbox reacts to it.
    this.tasks.store.drafts.subscribe(taskId => {
      const teamId = this.tasks.store.get(taskId)?.teamId
      if (teamId) this.options.onTaskChange?.(teamId)
    })
    // Parking pauses the session that holds the work; any change to a parked
    // message (or to one that was) re-derives its holder's paused state.
    this.mailbox.store.subscribe((_teamId, message) => {
      if (!message) return
      const holders = new Set<string>()
      if (message.claimedBy) holders.add(message.claimedBy)
      for (const [sessionId, parked] of this.parkedShown) if (parked.messageId === message.id) holders.add(sessionId)
      for (const sessionId of holders) this.refreshParked(sessionId)
    })
    this.dispatcher = this.teamMail.dispatcher
    // Restore runs off the boot path (async-transcript-parsing design D2):
    // persisted rows load without blocking server start, and the first
    // chat-attach awaits them via whenRestored(). The mailbox and wire-log
    // orphan pruning start only after the rows exist — pruning before the
    // restore would see an empty registry and delete every chat's wire log.
    this.restorePromise = this.restorePersisted()
      .then(async () => {
        if (this.isShutDown) return
        this.teamMail.start()
        // The executor boots after the mailbox and before its wakes install:
        // D14 recovery runs to its end, then every team with a running
        // execution resumes (plan-execution D5).
        await this.executionRuntime?.start()
        // Supervision sweeps once recovery has ended (plan-supervision D11).
        if (!this.isShutDown) this.supervisionMonitor?.start()
        // Work parked before a restart keeps its sessions paused.
        for (const sessionId of this.records.keys()) this.refreshParked(sessionId)
        // Logs of sessions deleted while the server was down are orphans now.
        void this.options.wireLogs?.pruneOrphans(new Set(this.records.keys()))
      })
      .catch(error => {
        logger.error('chat_sessions_restore_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  /** Resolves once persisted chat rows are restored (design D2). */
  whenRestored(): Promise<void> {
    return this.restorePromise
  }

  /** Recorded per-profile limit events (profile routing). */
  get limitEvents(): LimitEventStore {
    return this.teamMail.limits
  }

  /** Reload every user-level routing rule (Reload routing rules). */
  reloadRoutingRules(): Promise<RuleLoadReport> {
    return this.teamMail.rules.reload()
  }

  /** Rule load status and this team's routing decisions (mailbox view). */
  routingState(teamId: string): TeamRoutingState {
    return { rules: this.teamMail.rules.lastReport(), decisions: this.teamMail.router.decisions(teamId) }
  }

  /** The team's live sessions per worktree plus pending spawns (mailbox view). */
  teamRoster(teamId: string): TeamWorktreeOccupancy[] {
    return this.teamMail.roster(teamId)
  }

  /** The team's per-message waiting reasons (mailbox view, team-waiting-reasons D3). */
  waitingFor(teamId: string): Record<string, WaitingReason> {
    return this.teamMail.waitingFor(teamId)
  }

  /**
   * The start guard's refusal text, read-only (team-waiting-reasons D2): the
   * unavailable-recipient reason carries it; `available` keeps calling the
   * guard itself, unchanged.
   */
  startBlockerFor(record: ChatSessionRecord): string | null {
    return this.startBlocker(record)
  }

  /** The human hands parked work to a group or session of its team. */
  handOff(messageId: string, target: HandoffTarget): TeamMessage {
    return this.teamMail.handOff(messageId, target)
  }

  /** Live (non-archived) members of a team's group per profile, for cap warnings. */
  /** The team's stored default approval policy for spawned members; null = not set (team-approval-default D3). */
  teamApprovalDefault(teamId: string): ChatApprovalPolicy | null {
    return this.teamMail.staffing.approvalDefaults.get(teamId)
  }

  /**
   * Store the team's default (the human's Team page action only — no agent
   * tool calls this). Later spawns read it; no existing session changes.
   */
  setTeamApprovalDefault(teamId: string, policy: ChatApprovalPolicy): void {
    this.teamMail.staffing.approvalDefaults.set(teamId, policy)
  }

  groupProfileCounts(teamId: string, groupId: string): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const record of this.records.values()) {
      if (record.archivedAt != null || record.groupId !== groupId || this.teams.teamOf(record.sessionId)?.teamId !== teamId) continue
      const profileId = record.claudeProfileId ?? 'default'
      counts[profileId] = (counts[profileId] ?? 0) + 1
    }
    return counts
  }

  /** The team's recorded context-exhaustion episodes (chat-context-exhaustion D8); the workspace reads them. */
  exhaustionEpisodes(teamId: string): ExhaustionEpisode[] {
    return this.teamMail.exhaustionNotes.episodes(teamId)
  }

  /** Each open plan's attention facts (plan-supervision D13); none without team services. */
  planAttentionFacts(teamId: string): PlanAttentionFact[] {
    const reads = this.planAttentionReads
    return reads === null ? [] : planAttentionFacts(reads, teamId, new Date())
  }

  /** The summary window's durable plan rows (plan-supervision D13). */
  planSummaryRows(teamId: string, since: string): PlanSummaryRows {
    const reads = this.planSummaryReads
    if (reads === null) return { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }
    return planSummaryRows(reads, teamId, since)
  }

  /** Every record (live and archived) resolved to this team; the workspace reads it. */
  teamRecords(teamId: string): ChatSessionRecord[] {
    return [...this.records.values()].filter(record => this.teams.teamOf(record.sessionId)?.teamId === teamId)
  }

  /** The chats a conversation search covers: every non-archived record. */
  activeRecords(): ChatSessionRecord[] {
    return [...this.records.values()].filter(record => record.archivedAt == null)
  }

  /**
   * The calling session as the report tools see it (team-process-metrics D6):
   * its team and its group as the current group files define them, re-read
   * at each call so a `canReportProcess` edit applies at once.
   */
  private async reportCaller(sessionId: string): Promise<ReportCaller | null> {
    const record = this.records.get(sessionId)
    const teamId = this.teams.teamOf(sessionId)?.teamId
    if (!record || !teamId) return null
    const { catalog } = await loadTeamGroups(record.projectPath, this.options.profileCatalogHome)
    return {
      teamId,
      sessionId,
      group: record.groupId ? catalog.groups.get(record.groupId)?.group : undefined,
      groupIds: new Set(catalog.groups.keys()),
    }
  }

  /**
   * One chat's events for conversation search (chat-session-search D1).
   * Read-only: a loaded chat reads its memo plus live events; an unloaded one
   * is replayed transiently, so the result is never memoized, never moves the
   * chat's cwd, and never starts an agent. `readable: false` = the transcript
   * was missing or unparseable (the replay's placeholder notice is dropped).
   */
  async searchableEvents(sessionId: string): Promise<{ events: ChatEvent[]; readable: boolean }> {
    const record = this.records.get(sessionId)
    if (!record) return { events: [], readable: true }
    const memo = this.snapshotHistory.get(sessionId)
    if (memo) return { events: [...memo, ...(this.liveEvents.get(sessionId) ?? [])], readable: true }
    if (record.runtime === 'codex') {
      // The rollout is the one replay source (D8, M3); a never-started chat
      // has no rollout and searches its live events alone.
      if (!record.sdkSessionId && !record.transcriptPath) return { events: [...(this.liveEvents.get(sessionId) ?? [])], readable: true }
      const replay = await replayCodexRolloutAsync(record.transcriptPath)
      const live = this.liveEvents.get(sessionId) ?? []
      if (replay.status !== 'ok') return { events: [...live], readable: false }
      return { events: [...replay.events, ...live], readable: true }
    }
    if (!record.sdkSessionId) return { events: [...(this.liveEvents.get(sessionId) ?? [])], readable: true }
    const replay = await replayTranscriptFileAsync(
      await findTranscriptPathAsync(record.sdkSessionId),
      { excludeToolCallIds: this.liveToolCallIds(sessionId) }
    )
    const live = this.liveEvents.get(sessionId) ?? []
    if (replay.status !== 'ok') return { events: [...live], readable: false }
    return { events: [...replay.events, ...live], readable: true }
  }

  /** Paused state last pushed per session. */
  private readonly parkedShown = new Map<string, SessionParkedState>()

  private parkedState(sessionId: string): SessionParkedState | null {
    const parked = this.mailbox.store.parkedBy(sessionId)[0]
    if (!parked) return null
    const profileId = this.records.get(sessionId)?.claudeProfileId ?? 'default'
    return { messageId: parked.id, until: parked.parkedUntil, profileId, reason: `Provider limit on ${profileId}` }
  }

  private refreshParked(sessionId: string): void {
    if (!this.records.has(sessionId)) return
    const next = this.parkedState(sessionId)
    const shown = this.parkedShown.get(sessionId)
    if (JSON.stringify(next) === JSON.stringify(shown ?? null)) return
    if (next) this.parkedShown.set(sessionId, next)
    else this.parkedShown.delete(sessionId)
    this.options.registry.updateSession(sessionId, { parked: next })
  }

  /**
   * Agent-start provenance (team-process-metrics D2): hash what this spawn
   * launched with. Observational — a failure is logged, never thrown.
   */
  private recordAgentStart(sessionId: string, info: ChatSpawnInfo): void {
    try {
      const record = this.records.get(sessionId)
      const team = this.teams.teamOf(sessionId)
      const groupId = record?.groupId ?? null
      this.provenance.record({
        sessionId,
        teamId: team?.teamId ?? null,
        groupId,
        profileId: record?.claudeProfileId ?? 'default',
        model: info.model ?? record?.model ?? null,
        effort: info.effort == null ? null : String(info.effort),
        cwd: info.cwd,
        groupFile: groupId ? this.teams.catalogOf(sessionId)?.groups.get(groupId)?.file ?? null : null,
        promptAppend: info.systemPromptAppend,
        mainCheckout: team?.groupsRoot ?? worktreeRootOf(info.cwd),
        worktreeRoot: worktreeRootOf(info.cwd),
        env: info.env,
      })
      const contextWindow = Number(info.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW)
      this.observations.chat.settings(sessionId, {
        effort: info.effort ?? null,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
        driverVersion: null, thresholdSource: null,
      })
    } catch (error) {
      logger.warn('agent_start_record_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Each session's team (agent-teams); shared with the mailbox dispatcher. */
  readonly teams: SessionTeams
  /** The owner's outbound destinations (execution-safety-recovery D2); feeds every prompt's security note. */
  readonly outbound: OutboundDestinations
  /** The append-only audit tables' only writer (execution-safety-recovery D6). */
  private readonly outboundStore: OutboundStore
  /** The audit view's reads and the owner's acknowledge (execution-safety-recovery D9/D10). */
  readonly outboundAudit: OutboundService
  /** Each live session's observer, for D7's pending-while-the-spawn-lives. */
  private readonly outboundObservers: Map<string, OutboundObserver>
  /** Repository facts for the classifier (execution-safety-recovery D4). */
  private readonly outboundRepoFacts: RepoFactsResolver
  /** The team a human team view's `teamPath` addresses (team-workspace-pages D1). */
  readonly teamScopes: TeamScopes
  /** Last known name/group of each team's sessions, kept past kill (team-message-threads D3). */
  readonly directory: SessionDirectory
  readonly mailbox: TeamMailbox
  /** Team tasks (team-tasks); the task tools and UI actions go through it. */
  readonly tasks: TaskService
  /** Agent mailbox management (team-mailbox-management): rights, cancel, discard, list. */
  readonly management: MailboxManagement
  /** Task assignment (task-assignment); human dispatch, preview, and targets. */
  readonly assignments: AssignmentService
  /** Task results, findings, acceptance, handoffs, and release (task-results-handoffs). */
  readonly results: TaskResultService
  /** The Messages read model and its live feed (team-message-threads D1/4.3). */
  readonly messages: MessageFeed
  /** Product strategy (product-strategy); the strategy tools and UI actions go through it. */
  readonly strategies: StrategyService
  /** Completed turns of task-bound sessions (team-workspace D8): the summary's durable source. */
  readonly turnEnds: ChatTurnEndStore
  /** Agent starts and their input hashes (team-process-metrics D2). */
  readonly provenance: ProvenanceRecorder
  /** Per-turn token usage of every chat turn (team-process-metrics D1). */
  readonly turnUsage: ChatTurnUsageStore
  readonly observations: ProcessObservationService
  /** Process metrics (team-process-metrics D4/D5), shared by the `team_metrics` tool and the Metrics tab. */
  readonly metrics: MetricsReader
  /** Process reports and proposals (team-process-metrics D6): the report tools and the human's decide/link commands. */
  readonly reports: ProcessReportService
  readonly capacity: TeamCapacity
  private readonly turnUsageTracker: TurnUsageTracker
  /** Guards the teamMail calls on the driver-event path (never throws; a failed settle is retried). */
  private readonly mailGuard = new DriverMailGuard()
  /** Durable plans (durable-plans); the plan tools and UI actions go through it. */
  readonly plans: PlanService
  /** The plan workspace's bindings and command ledger (plan-workspace 1.2); the workspace connection reads it. */
  readonly planWorkspace: import('../plans/workspace/workspaceStore').PlanWorkspaceStore
  /** The plan workspace's document references (plan-workspace 1.2); the workspace connection reads it. */
  readonly planWorkspaceRefs: import('../plans/workspace/workspaceRefs').PlanWorkspaceRefs
  /** The per-message context store (plan-workspace §4); the send path records through it. */
  readonly planWorkspaceContext: import('../plans/workspace/workspaceContext').PlanWorkspaceContext
  /** The execution pin's read-only surface (plan-workspace 2.4, O4): the accessors executionPin.ts reads, no writer. */
  readonly planExecutionStore: import('../plans/workspace/executionPin').ExecutionPinStore
  /** The workspace runtime's supervision reads (plan-workspace 3.1); null without team services. */
  readonly planWorkspaceRuntimeReads: import('../plans/supervision/supervisionRead').SupervisionReads | null
  /** Plan executions (plan-execution): the human Start/Stop/Retry commands. */
  readonly executions: import('../plans/execution/ExecutionService').ExecutionService
  /** The execution runtime (plan-execution D5): boot recovery, wakes, and stop. */
  private readonly executionRuntime: import('../plans/execution/executionRuntime').ExecutionRuntime | null
  private readonly supervisionMonitor: import('../plans/supervision/SupervisionMonitor').SupervisionMonitor | null
  /** Promote, Cancel, and the promotion preview (integration-candidates D9). */
  readonly promotions: import('../plans/landing/integration/PromotionService').PromotionService
  /** The `task_checkpoint` tool (revision-control D7); null when plan services are absent. */
  readonly checkpoints: import('../plans/revisionControl/checkpointTool').CheckpointTool | null
  /** The one execution store, its ownership, and its wake hub (plan-execution D5/D7). */
  private readonly executionCore: ReturnType<typeof composeExecutionCore>
  /** The user-level team settings (plan-execution D16's floor map lives here). */
  readonly caps: TeamCaps
  /** Plan validation (plan-validation): reports, assessments, decisions, and the approval standing. */
  readonly validation: ValidationService
  /** Plan decisions (plan-supervision D4–D7): cards, the Lead's record, the owner's answer and override, fix tasks. */
  readonly decisions: DecisionService | null
  /** The plan attention's gatherer reads (plan-supervision D13); null without team services. */
  private readonly planAttentionReads: PlanAttentionReads | null
  /** The summary window's durable reads (plan-supervision D13); null without team services. */
  private readonly planSummaryReads: PlanSummaryRowReads | null
  /** The coalesced validation view for the Plans page pushes (plan-validation D11). */
  readonly validationDetail: ValidationDetailCache
  /** The one OpenSpec adapter (plan-validation D3); its probe is cached in-process. */
  private readonly validationAdapter: OpenspecAdapter
  /** Strategy impact reviews (strategy-revision-impact); the impact tools and UI actions go through it. */
  readonly impact: ImpactService
  readonly dispatcher: MailDispatcher
  private readonly teamMail: SessionMailbox

  /**
   * Worktree staffing's programmatic create (team-tasks D4): a group member
   * in the task's worktree with the group's profile and approval policy,
   * associated with the task and marked spawned. Resolves once the member's
   * team is known, so the dispatcher can deliver its first turn at once.
   */
  private async spawnMember(request: SpawnRequest): Promise<SpawnResult> {
    const result = await this.createAvailableSession({
      projectPath: request.projectPath, groupId: request.groupId, approvalPolicy: request.approvalPolicy,
      taskId: request.taskId, spawned: true,
      ...(request.profileId ? { claudeProfileId: request.profileId } : {}),
    })
    if (!result.ok) return result
    await this.teams.track(result.session.id, result.session.projectPath)
    return { ok: true, sessionId: result.session.id }
  }

  /** Create a chat session. Refused (no side effects) when auth is missing. */
  createSession(input: {
    projectPath: string
    name?: string
    claudeProfileId?: string
    /** Starting policy (reorg-settings-default-approval design D3); absent = manual. */
    approvalPolicy?: ChatApprovalPolicy
    /** Team group, already validated by createAvailableSession; absent = none. */
    groupId?: string
    /** Team task the session starts on (worktree staffing); absent = none. */
    taskId?: string
    /** Created by worktree staffing rather than the human. */
    spawned?: boolean
  }): ChatCreateResult {
    const project = resolveProjectDirectory(input.projectPath, this.options.isDirectory)
    if (!project.ok) return project
    const projectPath = project.path
    let launch: ChatLaunchConfiguration
    try {
      launch = this.launchFor(input.claudeProfileId, projectPath)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    // One resolution feeds both the gate and the stamped facts: a Codex
    // chat's login lives in the resolved home (defense in depth —
    // createAvailableSession already refused), a Claude chat's in its
    // environment. No runtimeFactsOf re-resolution, so stamp and gate can
    // never disagree.
    if (launch.runtime === 'codex') {
      // The fixture seam again: a fake runtime never checks a real login,
      // except under the e2e carve-out (codexGatesApply).
      if (this.codexGatesApply() && !hasCodexLogin(launch.codexHome)) {
        return { ok: false, error: this.codexLoginRefusal(launch.codexHome, input.claudeProfileId ?? null) }
      }
    } else {
      const authRefusal = this.authRefusal(input.claudeProfileId, projectPath)
      if (authRefusal) return { ok: false, error: authRefusal }
    }
    // The runtime facts are fixed at creation (codex-chat-sessions 3.3,
    // ruling R1): a later profile edit never moves an existing chat to
    // another driver or home — the mismatch refuses the start instead.
    const runtimeFacts: { runtime: ChatRuntime; codexHome: string | null } | null =
      launch.runtime === 'codex'
        ? { runtime: 'codex', codexHome: launch.codexHome }
        : { runtime: 'claude', codexHome: null }
    const sessionId = `chat-${crypto.randomUUID()}`
    const suppliedName = input.name?.trim()
    const name = suppliedName || generateSessionName()
    const now = new Date().toISOString()
    const record = {
      sessionId,
      name,
      projectPath,
      sdkSessionId: null as string | null,
      claudeProfileId: input.claudeProfileId ?? 'default',
      // The client's Settings default, sent on session-create; absent means
      // manual (older clients). Profiles never influence the policy.
      approvalPolicy: (input.approvalPolicy ?? 'manual') as ChatApprovalPolicy,
      runtime: runtimeFacts?.runtime ?? 'claude',
      codexHome: runtimeFacts?.codexHome ?? null,
      // chat-session-naming design D1: a name the user typed sticks forever,
      // one the generator produced is a placeholder a later title may replace.
      nameSource: (suppliedName ? 'manual' : 'placeholder') as ChatNameSource,
      groupId: input.groupId ?? null,
      taskId: input.taskId ?? null,
      spawned: input.spawned === true,
      status: 'waiting' as SessionStatus,
      createdAt: now,
      lastActivityAt: now,
    }
    this.records.set(sessionId, record)
    this.options.db.insertChatSession(record)
    // Spawned for a task that already closed (member-release D1): its mail
    // was dead-lettered, so it starts with no turn. Marked in the same tick
    // that persists it, so no restart can leave it unmarked; it is released
    // once it settles.
    if (record.spawned && record.taskId) this.teamMail.markSpawnedForClosedTask(sessionId, record.taskId)
    const session = this.toSession(record)
    this.options.registry.setChatSession(session)
    // The directory keys by team, so it records once resolution lands.
    void this.teams.track(sessionId, projectPath).then(() => this.syncDirectory(sessionId))
    return { ok: true, session }
  }

  /** True when the id is a known chat session. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId)
  }

  /** Archived chats attach for history without starting an agent. */
  isArchived(sessionId: string): boolean {
    return this.records.get(sessionId)?.archivedAt != null
  }

  /**
   * The session's Claude profile id (usage scoping, usage bar design D4):
   * plan usage is tracked and broadcast per profile, never per session.
   */
  profileIdOf(sessionId: string): string {
    return this.records.get(sessionId)?.claudeProfileId ?? 'default'
  }

  /**
   * The provider the session's profile belongs to (providers-and-workers
   * 5.1): plan usage is held and pulled per provider, so sibling models of
   * one provider read the same report. An unknown profile stands in as its
   * own provider, like the routing helpers.
   */
  providerIdOf(sessionId: string): string {
    const record = this.records.get(sessionId)
    return providerOf(
      record?.claudeProfileId ?? 'default',
      catalogCtx(this.options.profileCatalogHome, record?.projectPath)
    )
  }

  /**
   * The session's live context reading, or the record's last persisted one,
   * else null (the snapshot's precedence, read-only for the workspace's
   * passive health — design D5). Never attaches to the driver or refreshes
   * anything.
   */
  contextReadingOf(sessionId: string): ChatContextUsage | null {
    return this.contextReadings.get(sessionId) ?? this.records.get(sessionId)?.contextUsage ?? null
  }

  /**
   * The provider's latest plan-usage report, or null (providers-and-workers
   * 5.1): a read-only public accessor over the same in-memory store the
   * snapshot and TeamCapacity read. Never claims a pull or refreshes.
   */
  providerUsageOf(providerId: string): ChatUsageReport | null {
    return this.usageLimits.get(providerId)
  }

  /**
   * The catalog's merged definition of the provider the session's profile
   * belongs to (read-only, for routing facts like host-login applicability,
   * plan-workspace LC5.4), from the shared resolution memo like `providerOf`.
   * A provider the catalog no longer defines has no definition.
   */
  providerDefinitionOf(sessionId: string): MergedProvider | null {
    const record = this.records.get(sessionId)
    const known = resolvedCatalog(catalogCtx(this.options.profileCatalogHome, record?.projectPath)).definitions()
    return known.get(this.providerIdOf(sessionId)) ?? null
  }

  /**
   * Read-only history for a chat session: the stored SDK transcript replayed
   * into ChatEvents (with dead requests marked cancelled), or a
   * "history unavailable" notice. Sessions that never started have no SDK id
   * and replay as empty. Unknown sessions return null.
   */
  getHistory(sessionId: string): TranscriptReplay | null {
    const record = this.records.get(sessionId)
    if (!record) return null
    if (record.runtime === 'codex') {
      // A Codex chat's transcript is the rollout its start reported
      // (codex-chat-sessions D8, M3) — the one replay source, never a Claude
      // `<id>.jsonl`. A chat that never started has no rollout and replays
      // as empty.
      if (!record.sdkSessionId && !record.transcriptPath) return { status: 'ok', events: [], cwd: null }
      return replayCodexRollout(record.transcriptPath)
    }
    if (!record.sdkSessionId) {
      return { status: 'ok', events: [], cwd: null }
    }
    const replay = replayTranscriptFile(
      findTranscriptPath(record.sdkSessionId),
      { excludeToolCallIds: this.liveToolCallIds(sessionId) }
    )
    // The transcript's last cwd is where the conversation actually is
    // (worktree tracking design D3): a session whose transcript moved while
    // the server was down follows it on attach too, not only at startup —
    // the same overwrite a live CwdChanged firing would have made.
    if (replay.cwd) this.handleDriverCwdChanged(sessionId, replay.cwd)
    return replay
  }

  /**
   * Submit a user turn. The driver (and behind it the SDK subprocess) is
   * created lazily here — the first turn pays the spawn cost, creation never
   * blocks on process startup. A stored SDK id whose transcript is missing
   * refuses the turn rather than silently starting a fresh conversation
   * (design D5): the id is kept so a restored transcript can still resume.
   */
  async send(sessionId: string, text: string, workspaceContext?: WorkspaceMessageEnvelope): Promise<ChatActionResult> {
    // Recovery can replace the record's path: finish it before checking the
    // directory or resolving the launch configuration. Awaited, never the
    // synchronous capture: a large history must not block the server
    // (bounded-history-capture D1).
    await this.loadHistory(sessionId)
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const blocked = this.startBlocker(record)
    if (blocked) {
      return { ok: false, error: blocked }
    }
    // A contextual send validates whole before the driver mints anything
    // (plan-workspace §4 S1): a refusal stores no row, opens no turn, and
    // leaves the client draft intact.
    let stored: WorkspaceMessageContext | null = null
    if (workspaceContext !== undefined) {
      const validated = await validateWorkspaceSend(record.projectPath, workspaceContext, this.workspaceSendDeps())
      if (!validated.ok) return { ok: false, error: validated.error }
      stored = validated.context
    }
    let driver: ChatAgentDriver | null
    try {
      driver = await this.ensureDriver(sessionId)
    } catch (error) {
      return { ok: false, error: sdkLoadError(error) }
    }
    if (!driver) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (stored) {
      if (!driver.sendWorkspaceContext) {
        return { ok: false, error: "This chat's runtime does not carry plan-workspace contexts." }
      }
      const sent = this.sendDriverText(driver, text, stored)
      if (!sent.ok) return { ok: false, error: sent.error }
    } else {
      const sent = this.sendDriverText(driver, text)
      if (!sent.ok) return { ok: false, error: sent.error }
    }
    this.touch(sessionId)
    return { ok: true }
  }

  /**
   * Submit a user turn, settling a launch refusal as a failed send
   * (provider-relay-setup correction B): the typed pre-spawn refusal means
   * no child composed or started, so the caller sees the refusal instead of
   * a rejection. Every other throw rejects exactly as before.
   */
  private sendDriverText(driver: ChatAgentDriver, text: string, stored?: WorkspaceMessageContext): { ok: true } | { ok: false; error: string } {
    try {
      // The caller checked sendWorkspaceContext exists whenever stored is set.
      if (stored) return driver.sendWorkspaceContext!(text, stored)
      driver.send(text)
      return { ok: true }
    } catch (error) {
      if (error instanceof RegisteredNameRefusal) return { ok: false, error: error.message }
      throw error
    }
  }

  /** The validation reads, wired to the plan services (plan-workspace §4.1). */
  private workspaceSendDeps() {
    return {
      resolveTeam: (projectPath: string) => resolveTeam(projectPath),
      planForTeam: (teamId: string, planId: string) => {
        const plan = this.plans.store.forTeam(teamId, planId)
        return plan ? { id: plan.id, title: plan.title } : null
      },
      versionInputs: (planId: string) => ({
        approved: this.plans.store.approvedRevision(planId),
        revisions: this.plans.store.revisions(planId),
        drafts: this.plans.store.drafts(planId),
      }),
      execution: (executionId: string) => this.planExecutionStore.execution(executionId),
      refsOf: (teamId: string, planId: string) => this.planWorkspaceRefs.refsOf(teamId, planId),
    }
  }

  /**
   * Re-attach the stored context to user events by message uuid
   * (plan-workspace §4.3): snapshot and history assembly join through here,
   * so a replayed transcript renders the attachment the live event showed.
   * A row whose message never reached the transcript renders nothing, and
   * an event without a uuid (legacy) reads as absent.
   */
  private attachWorkspaceContext(sessionId: string, events: ChatEvent[]): ChatEvent[] {
    let attached = false
    const joined = events.map(event => {
      if (event.type !== 'user_message' || typeof event.messageUuid !== 'string' || event.messageUuid === '') return event
      const stored = this.planWorkspaceContext.contextOf(sessionId, event.messageUuid)
      if (!stored) return event
      attached = true
      return { ...event, workspaceContext: stored.context }
    })
    return attached ? joined : events
  }

  /**
   * Attach-time start (design D1): spawn the agent process without sending a
   * prompt, so its command list is available before the first message. Goes
   * through the same start guard as send and the same ensureDriver, so
   * concurrent attaches and sends share one driver and a dead driver is
   * restarted. Refusals report the guard's error; a failed spawn surfaces as
   * a session error event from the driver.
   */
  async start(sessionId: string): Promise<ChatActionResult> {
    // Direct starts need the same recovery ordering as attach and send.
    await this.loadHistory(sessionId)
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const blocked = this.startBlocker(record)
    if (blocked) {
      return { ok: false, error: blocked }
    }
    let driver: ChatAgentDriver | null
    try {
      driver = await this.ensureDriver(sessionId)
    } catch (error) {
      return { ok: false, error: sdkLoadError(error) }
    }
    if (!driver) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    // The same launch refusal as send: the start settles failed and no
    // child composed (correction B).
    try {
      driver.start()
    } catch (error) {
      if (error instanceof RegisteredNameRefusal) return { ok: false, error: error.message }
      throw error
    }
    return { ok: true }
  }

  /** Stop button: abort the in-flight turn without removing the session. */
  interrupt(sessionId: string): ChatActionResult {
    if (!this.records.has(sessionId)) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    // An idle session (no driver yet) has nothing to interrupt.
    this.drivers.get(sessionId)?.interrupt()
    return { ok: true }
  }

  /**
   * Archive: stop the agent process exactly the way kill stops it (interrupt
   * the in-flight turn, settle pending requests as cancelled, terminate), but
   * keep the record, SDK conversation id, live-event history, and protocol
   * log (chat-archive design D2). The driver is forgotten, and ensureDriver
   * refuses archived sessions, so nothing respawns it until restore.
   */
  archive(sessionId: string): ChatActionResult {
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    const driver = this.drivers.get(sessionId)
    if (driver) {
      // Interrupt first so subscribers see request_resolved(cancelled) and
      // turn_interrupted; kill then ends the process without the
      // exited-unexpectedly error a bare close would report.
      driver.interrupt()
      driver.kill()
      this.observations.chat.processEnded(sessionId)
    }
    this.teamMail.settleRecipient(sessionId)
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    this.outboundObservers.delete(sessionId)
    // The transcript is final once the agent is stopped: release the title
    // tail with it (design D4 risk note).
    this.releaseTitleWatch(sessionId)
    // The archived chat shows no activity row (design D5): any in-flight
    // phase ended with the driver above.
    this.clearActivity(sessionId)
    // Agent notices died with the process (notification strip design D4);
    // the archived chat keeps only its profile's account notice.
    this.clearAgentNotices(sessionId, { emit: true })
    // The archived header shows the stored reading, frozen with the agent:
    // write the freshest in-memory value, then forget the live slot so
    // snapshots fall back to the column.
    this.persistContextUsage(sessionId)
    this.contextReadings.delete(sessionId)
    // Status returns to waiting: archived sessions never look busy.
    this.applyPatch(sessionId, {
      archivedAt: new Date().toISOString(),
      status: 'waiting',
    })
    // Archived by any path: a pending release is settled by the archive
    // itself (member-release D1); a later restore starts clean.
    this.teamMail.cancelPendingRelease(sessionId)
    // Every release path lands here (member release included), so one wake
    // covers them: an archived member frees what its execution waits on (D5).
    // Fired only once the archive succeeded (N2).
    this.executionCore.wakes.archived(sessionId)
    return { ok: true }
  }

  /**
   * Restore: clear archived_at. The next send lazily recreates the driver
   * with the stored conversation id, exactly as after a server restart.
   */
  restore(sessionId: string): ChatActionResult {
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (record.archivedAt == null) return { ok: true }
    this.applyPatch(sessionId, { archivedAt: null })
    // A restored member stays live: it is never released again for the same
    // close (member-release D1).
    this.teamMail.cancelPendingRelease(sessionId)
    return { ok: true }
  }

  /**
   * Rename a chat session (chat-session-naming design D1). A rename is a
   * claim: it sets `manual` provenance, which is terminal, so no later
   * generated title replaces it. Names are free text — trimmed non-empty —
   * because chat sessions have no tmux window to name (design D5).
   */
  rename(sessionId: string, name: string): ChatActionResult {
    const trimmed = name.trim()
    if (!trimmed) {
      return { ok: false, error: 'Name cannot be empty' }
    }
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    this.applyPatch(sessionId, { name: trimmed, nameSource: 'manual' })
    return { ok: true }
  }

  /**
   * Switch a session's approval policy live (chat-auto-approve-tools design
   * D4): persists and broadcasts the new policy, records a transcript
   * notice, and lets a live driver grant approvals already pending as cards.
   * Archived sessions refuse the change; setting the current value is a
   * no-op, and switching to manual affects only later requests.
   */
  setApprovalPolicy(
    sessionId: string,
    policy: ChatApprovalPolicy
  ): ChatActionResult {
    if (policy !== 'manual' && policy !== 'auto') {
      return { ok: false, error: `Unsupported approval policy ${String(policy)}` }
    }
    const record = this.records.get(sessionId)
    if (!record) {
      return { ok: false, error: `Unknown chat session ${sessionId}` }
    }
    if (record.archivedAt != null) {
      return { ok: false, error: ARCHIVED_SESSION_ERROR }
    }
    if ((record.approvalPolicy ?? 'manual') === policy) return { ok: true }
    this.applyPatch(sessionId, { approvalPolicy: policy })
    // The notice rides the same live-event path as driver events (sequence
    // assignment, snapshot inclusion) whether or not a driver is running.
    // It precedes the driver's policy grants so the transcript reads in order.
    this.handleDriverEvent(sessionId, {
      type: 'notice',
      text: policy === 'auto' ? 'Auto-approve on' : 'Auto-approve off',
      id: `evt-${crypto.randomUUID()}`,
      sequence: 0,
      at: new Date().toISOString(),
    } as ChatEvent)
    this.drivers.get(sessionId)?.onApprovalPolicyChanged(policy)
    return { ok: true }
  }

  resolveApproval(
    sessionId: string,
    requestId: string,
    decision: ChatApprovalDecision
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending approval with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.resolveApproval(requestId, decision)
  }

  answerQuestion(
    sessionId: string,
    requestId: string,
    answers: Record<string, ChatQuestionAnswer>
  ): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending question with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.answerQuestion(requestId, answers)
  }

  /** Hold a question's deadline (question-auto-answer D4, Wait for me). */
  holdQuestion(sessionId: string, requestId: string): ChatActionResult {
    const driver = this.drivers.get(sessionId)
    if (!driver) {
      return {
        ok: false,
        error: this.records.has(sessionId)
          ? `No pending question with id ${requestId}; the session has no in-flight turn`
          : `Unknown chat session ${sessionId}`,
      }
    }
    return driver.holdQuestion(requestId)
  }

  getPendingRequests(sessionId: string): ChatPendingRequest[] {
    return this.drivers.get(sessionId)?.getPendingRequests() ?? []
  }

  /** Keep the session's observer for D7's pending-while-the-spawn-lives reads. */
  private trackObserver(sessionId: string, observer: OutboundObserver): OutboundObserver {
    this.outboundObservers.set(sessionId, observer)
    return observer
  }

  /** Kill: abort the agent, settle pending requests, forget the session. */
  kill(sessionId: string): boolean {
    const record = this.records.get(sessionId)
    if (!record) return false
    this.drivers.get(sessionId)?.kill()
    this.observations.chat.processEnded(sessionId)
    this.teamMail.settleRecipient(sessionId)
    this.drivers.delete(sessionId)
    this.driverPromises.delete(sessionId)
    this.outboundObservers.delete(sessionId)
    this.releaseTitleWatch(sessionId)
    this.cancelCwdRefresh(sessionId)
    // A killed session never releases; its pending row is moot (member-release D1).
    this.teamMail.cancelPendingRelease(sessionId)
    this.records.delete(sessionId)
    this.mailbox.store.deadLetterDirectTo(sessionId, 'killed-recipient')
    this.dispatcher.notify()
    this.snapshotHistory.delete(sessionId)
    this.retryableHistory.delete(sessionId)
    this.liveEvents.delete(sessionId)
    this.activities.delete(sessionId)
    this.contextReadings.delete(sessionId)
    this.workerRows.delete(sessionId)
    this.backgroundTaskRows.delete(sessionId)
    this.backgroundTaskRecords.delete(sessionId)
    this.clearAgentNotices(sessionId)
    this.sessionCredentials.delete(sessionId)
    // While the team entry still exists, so the callback can resolve it.
    this.options.onSessionRecordChange?.(sessionId)
    this.teams.forget(sessionId)
    this.options.registry.removeChatSession(sessionId)
    this.options.db.deleteChatSession(sessionId)
    void this.options.wireLogs?.delete(sessionId).catch(() => {})
    // The session is gone for good; its worker rows go with it (D6).
    void this.options.workerStore?.delete(sessionId).catch(() => {})
    void this.options.taskStore?.delete(sessionId).catch(() => {})
    return true
  }

  /** Server shutdown: settle every driver (callbacks cannot survive it). */
  shutdown(): void {
    // Any CLI process group the adapter left running dies with us otherwise.
    this.validationAdapter.dispose()
    // A restore still in flight stops at its next row (design D2).
    this.isShutDown = true
    this.observations.stop()
    this.mailGuard.close()
    this.teamMail.close()
    // The executor stops with the server: wakes drop, the timer clears, new ticks refuse (D5).
    this.executionRuntime?.stop()
    this.supervisionMonitor?.stop()
    // Provider usage refreshes die with the server: timers stop now, and the
    // in-flight continuations check isShutDown before publishing.
    this.stopProviderUsageRefresh()
    for (const [id, driver] of this.drivers) {
      driver.shutdown()
      this.observations.chat.processEnded(id)
    }
    this.drivers.clear()
    this.driverPromises.clear()
    this.activities.clear()
    // Notices die with their processes (notification strip design D4); the
    // account store holds nothing per session either, so nothing survives.
    for (const sessionId of this.agentNotices.keys()) {
      this.clearAgentNotices(sessionId)
    }
    this.sessionCredentials.clear()
    // Shutdown settles like kill, but the rows survive it: write each live
    // reading so a restart restores the last one seen (design D5).
    for (const [sessionId] of this.contextReadings) {
      this.persistContextUsage(sessionId)
    }
    this.contextReadings.clear()
    for (const sessionId of this.titleWatchers.keys()) {
      this.releaseTitleWatch(sessionId)
    }
    for (const sessionId of this.cwdRefreshTimers.keys()) {
      this.cancelCwdRefresh(sessionId)
    }
  }

  /**
   * SDK session ids of all known chat sessions (live and restored) — used by
   * log discovery to exclude chat transcripts from agent-session matching
   * (design D6).
   */
  getSdkSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const record of this.records.values()) {
      if (record.sdkSessionId) ids.add(record.sdkSessionId)
    }
    for (const id of this.restoringSdkIds) ids.add(id)
    return ids
  }

  // ---------------------------------------------------------------- internals

  /**
   * The single start guard (add-chat-slash-commands design D1): the refusal
   * error for a spawn that must not happen — an archived session, a stored
   * conversation whose transcript is missing, or a project directory that no
   * longer exists — or null when a (re)spawn may proceed. `send` and `start`
   * (attach) both go through it, so their errors are identical.
   */
  private startBlocker(record: ChatSessionRecord): string | null {
    if (record.archivedAt != null) return ARCHIVED_SESSION_ERROR
    const spawning = !this.driverPromises.has(record.sessionId)
    // A Codex thread's transcript is the rollout its start reported
    // (codex-chat-sessions D8), never a Claude `<id>.jsonl`. Left bare, the
    // fixture seam would compute a Claude .jsonl check for a real Codex chat
    // under the e2e carve-out, so the same gate applies here.
    const codexRollout = record.runtime === 'codex' && this.codexGatesApply()
    if (
      record.sdkSessionId &&
      // Sync discovery acceptable: a per-request existence check, not the
      // boot path (async-transcript-parsing design D4).
      !this.drivers.has(record.sessionId) &&
      spawning &&
      !(codexRollout
        ? record.transcriptPath != null && existsSync(record.transcriptPath)
        : this.transcriptPaths.existing(record.sdkSessionId))
    ) {
      return (
        'Cannot resume this conversation: the agent transcript is missing. ' +
        `Restore ${codexRollout ? record.transcriptPath ?? `the rollout of ${record.sdkSessionId}` : `${record.sdkSessionId}.jsonl`} or create a new chat session.`
      )
    }
    const live = this.drivers.get(record.sessionId)
    if (
      (!live || live.isDead) &&
      spawning &&
      !(this.options.isDirectory ?? isExistingDirectory)(record.projectPath)
    ) {
      // A running process keeps its cwd; only a (re)spawn needs the directory.
      return (
        `Cannot start the agent: the project directory ${record.projectPath} no longer exists. ` +
        'Create a new chat session in an existing directory.'
      )
    }
    // The runtime is fixed at creation (codex-chat-sessions 3.3, R1): a
    // profile edited to another runtime — or, for a Codex chat, another
    // home — never moves the chat. The refusal states which fact changed and
    // never names a home. A profile that no longer resolves keeps its
    // existing error path.
    const runtimeFacts = this.runtimeFactsOf(record.claudeProfileId ?? 'default', record.projectPath)
    if (runtimeFacts) {
      const stored = record.runtime ?? 'claude'
      if (runtimeFacts.runtime !== stored) {
        return (
          `Cannot start the agent: this chat's profile changed runtime (${stored} → ${runtimeFacts.runtime}) since the chat was created. ` +
          'Create a new chat session with the profile\'s current runtime.'
        )
      }
      if (runtimeFacts.runtime === 'codex' && runtimeFacts.codexHome !== (record.codexHome ?? null)) {
        return (
          'Cannot start the agent: this chat\'s profile\'s Codex home changed since the chat was created. ' +
          'Create a new chat session with the profile\'s current Codex home.'
        )
      }
    }
    // A Codex chat whose stored home lost its login cannot start (4.2); the
    // mismatch refusals above still win, and the ensureDriver gates refuse
    // with the same text when a send reaches the driver first. The fixture
    // (a fake runtime) starts no Codex child and checks no login — except
    // under the e2e carve-out (codexGatesApply).
    if (
      this.codexGatesApply() &&
      (record.runtime ?? 'claude') === 'codex' &&
      record.codexHome &&
      !hasCodexLogin(record.codexHome)
    ) {
      return this.codexLoginRefusal(record.codexHome, record.claudeProfileId ?? null)
    }
    return null
  }

  /**
   * The Codex-specific start refusal for a record, or null (codex-chat-
   * sessions 4.2): the profile's runtime or home no longer matching the
   * chat's creation-fixed facts, else the stored home's login. Shared by
   * startBlocker (waiting reasons, mail eligibility) and the ensureDriver
   * gates (the hard refusal when a send starts the agent), so both name the
   * same fault the same way.
   */
  private codexStartRefusal(record: ChatSessionRecord, launch: ChatLaunchConfiguration): string | null {
    // The fixture seam (see checkExecutable): an injected fake runtime
    // starts no Codex child, so no real gate applies — except under the e2e
    // carve-out (codexGatesApply).
    if (!this.codexGatesApply()) return null
    const stored = record.runtime ?? 'claude'
    if (launch.runtime !== 'codex') {
      return (
        `Cannot start the agent: this chat's profile changed runtime (${stored} → ${launch.runtime}) since the chat was created. ` +
        'Create a new chat session with the profile\'s current runtime.'
      )
    }
    if (launch.codexHome !== (record.codexHome ?? null)) {
      return (
        'Cannot start the agent: this chat\'s profile\'s Codex home changed since the chat was created. ' +
        'Create a new chat session with the profile\'s current Codex home.'
      )
    }
    // The home-mismatch check above guarantees the stored home for a
    // resolvable profile; a null home here cannot pass the launch gate.
    const home = record.codexHome
    if (!home || !hasCodexLogin(home)) {
      return this.codexLoginRefusal(home ?? launch.codexHome, record.claudeProfileId ?? null)
    }
    return null
  }

  /**
   * The login refusal for one Codex chat: the message names the profile
   * (never the home path — N1); the home goes only to the server log.
   */
  private codexLoginRefusal(codexHome: string, profileId: string | null): string {
    logger.warn('codex_login_missing', { profileId: profileId ?? 'default', codexHome })
    return codexLoginErrorMessage(profileId ?? 'default')
  }

  /**
   * Whether the real Codex gates apply to this manager. Production (no
   * injected queryFactory) always gates; the development fixture starts no
   * Codex child unless the e2e run configures a Codex executable
   * (KAWAI_CODEX_PATH), in which case a Codex chat and all its gates —
   * executable, login, rollout, start refusals — run for real (8.1).
   */
  private codexGatesApply(): boolean {
    return !this.options.queryFactory || !!process.env.KAWAI_CODEX_PATH
  }

  /**
   * Tool call ids a live (non-dead) driver has seen. Transcript replay must
   * not mark those as cancelled — the live stream still owns their outcome.
   */
  private liveToolCallIds(sessionId: string): Set<string> {
    const driver = this.drivers.get(sessionId)
    if (!driver || driver.isDead) return new Set()
    return driver.getSeenToolCallIds()
  }

  /** Load chat_sessions rows into the registry as idle chat sessions. */
  private async restorePersisted(): Promise<void> {
    // The rows are read synchronously, before the first await, so their SDK
    // ids are excluded from log discovery from the constructor on.
    const rows = this.options.db.getChatSessions()
    for (const row of rows) {
      if (row.sdkSessionId) this.restoringSdkIds.add(row.sdkSessionId)
    }
    // One walk of the projects tree names every transcript (instead of one
    // walk per row). Archived rows register at once with their stored name
    // and path; their title/cwd catch-up runs after whenRestored resolves,
    // so hundreds of archived transcripts never hold up the live chats or
    // the mailbox start.
    // The index is built at the first row that has a transcript, so rows
    // before it still register synchronously, as they always have.
    let transcripts: Map<string, string> | null = null
    const deferred: ChatSessionRecord[] = []
    try {
      for (const row of rows) {
        if (this.isShutDown) return
        if (row.sdkSessionId && !transcripts) {
          transcripts = await indexTranscripts()
          if (this.isShutDown) return
        }
        if (row.archivedAt != null) deferred.push(row)
        await this.restoreRow(row, transcripts ?? new Map(), row.archivedAt == null)
      }
    } finally {
      this.restoringSdkIds.clear()
    }
    if (!transcripts) return
    void this.catchUpArchived(deferred, transcripts).catch(error => {
      logger.warn('chat_archived_catch_up_failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * The deferred title/cwd catch-up of archived rows, one transcript at a
   * time. A row restored, killed, or otherwise changed since it registered
   * is skipped: the live paths own it from then on.
   */
  private async catchUpArchived(
    rows: ChatSessionRecord[],
    transcripts: Map<string, string>
  ): Promise<void> {
    for (const row of rows) {
      if (this.isShutDown) return
      const registered = this.records.get(row.sessionId)
      const filePath = row.sdkSessionId ? transcripts.get(`${row.sdkSessionId}.jsonl`) : undefined
      if (!registered || !filePath) continue
      const meta = await scanTranscriptMeta(filePath)
      if (this.isShutDown) return
      if (this.records.get(row.sessionId) !== registered) continue
      if (meta.title) this.applyTranscriptTitle(row.sessionId, meta.title.title, meta.title.source)
      if (meta.cwd && meta.cwd !== registered.projectPath) {
        this.applyPatch(row.sessionId, { projectPath: meta.cwd })
      }
    }
  }

  /** Restore one persisted row (design D2): status, title/cwd catch-up, workers. */
  private async restoreRow(
    row: ChatSessionRecord,
    transcripts: Map<string, string>,
    catchUp: boolean
  ): Promise<void> {
    let record = row
    // Pending requests and in-flight turns died with the old process; a
    // restored session is always idle.
    if (record.status !== 'waiting') {
      record = { ...record, status: 'waiting' }
      this.options.db.updateChatSession(record.sessionId, {
        status: 'waiting',
      })
    }
    // Title catch-up (chat-session-naming design D4): a session whose name
    // was never user-set adopts its transcript's latest title now, so the
    // list is correct for sessions nobody opens. Nothing is persisted here —
    // the row re-derives on the next restart the same way (the deferred
    // archived pass adopts it through the live tail's persisted path).
    // Cwd catch-up (worktree tracking design D3): the transcript's last
    // cwd is where the conversation actually is — the agent may have
    // entered a worktree before the restart. Unlike the title this is
    // persisted, matching what the live CwdChanged firing would have
    // written, so the row and the registry agree from here on.
    // The path comes from the boot index and the meta from one streaming
    // scan (bounded-boot-restore design D1/D2) — no sync fs on the
    // event loop at boot. Archived rows catch up later (catchUpArchived).
    const indexed = record.sdkSessionId ? transcripts.get(`${record.sdkSessionId}.jsonl`) : undefined
    if (record.sdkSessionId && indexed) this.transcriptPaths.remember(record.sdkSessionId, indexed)
    if (catchUp && indexed) {
      const meta = await scanTranscriptMeta(indexed)
      // Shut down mid-read: the database may be closed already.
      if (this.isShutDown) return
      if ((record.nameSource ?? 'manual') !== 'manual' && meta.title) {
        record = { ...record, name: meta.title.title, nameSource: meta.title.source }
      }
      if (meta.cwd && meta.cwd !== record.projectPath) {
        record = { ...record, projectPath: meta.cwd }
        this.options.db.updateChatSession(record.sessionId, {
          projectPath: meta.cwd,
        })
      }
    }
    // Worker-roster recovery (workers design D6): a sidecar row still
    // marked running can never gain an outcome — the process that owed it
    // is gone — so it recovers as stopped. The corrected roster is
    // rewritten so the file and the rows agree.
    if (this.options.workerStore) {
      const records = this.options.workerStore.read(record.sessionId)
      if (records.length > 0) {
        const recovered: ChatWorker[] = records.map((entry) => ({
          ...entry,
          ...(entry.status === 'running' ? { status: 'stopped' as const } : {}),
          live: false,
          elapsedMs: 0,
        }))
        this.workerRows.set(record.sessionId, recovered)
        void this.options.workerStore
          .write(record.sessionId, recovered)
          .catch(() => {})
      }
    }
    // Background-task recovery (background tasks D6), same contract: a row
    // still running recovers as stopped, and the corrected roster is
    // rewritten so the file and the rows agree.
    if (this.options.taskStore) {
      const taskRecords = this.options.taskStore.read(record.sessionId)
      if (taskRecords.length > 0) {
        const corrected = taskRecords.map((entry) =>
          entry.status === 'running' ? { ...entry, status: 'stopped' as const } : entry
        )
        this.backgroundTaskRecords.set(record.sessionId, corrected)
        this.backgroundTaskRows.set(record.sessionId, corrected.map((entry) => ({
          taskId: entry.taskId,
          ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
          kind: entry.kind,
          ...(entry.description !== undefined ? { description: entry.description } : {}),
          status: entry.status,
          live: false,
          startedAtMs: entry.startedAtMs,
          ...(entry.endedAtMs !== undefined ? { endedAtMs: entry.endedAtMs } : {}),
          elapsedMs: entry.endedAtMs !== undefined ? Math.max(0, entry.endedAtMs - entry.startedAtMs) : 0,
          ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
        })))
        void this.options.taskStore.write(record.sessionId, corrected).catch(() => {})
      }
    }
    this.records.set(record.sessionId, record)
    this.options.registry.setChatSession(this.toSession(record))
    void this.teams.track(record.sessionId, record.projectPath)
  }

  /**
   * Adopt a transcript title for a session whose name is not user-set
   * (design D1/D2): placeholder and auto names follow each newer title; a
   * manual name is never touched. A `custom-title` row counts as user-set
   * (design D7), so adopting it also pins the name.
   */
  private applyTranscriptTitle(
    sessionId: string,
    title: string,
    source: 'auto' | 'manual'
  ): void {
    const record = this.records.get(sessionId)
    if (!record || (record.nameSource ?? 'manual') === 'manual') return
    if (record.name === title && record.nameSource === source) return
    this.applyPatch(sessionId, { name: title, nameSource: source })
  }

  /**
   * Start following a session's transcript for title rows. The transcript is
   * created by the first message, which can arrive much later than the SDK id
   * (the agent starts on attach, with no prompt), and a later send reuses the
   * driver without re-running this. So the locate retry lives as long as the
   * session does — giving up would pin the placeholder for the whole
   * conversation. Polls back off to `titleLocateIntervalMs * 7.5`.
   */
  private watchSessionTitle(sessionId: string, attempt = 0): void {
    if (this.titleWatchers.has(sessionId)) return
    const record = this.records.get(sessionId)
    if (!record || record.archivedAt != null || !record.sdkSessionId) return
    // A Codex chat's tail follows its rollout for receipts only: its name
    // is Kawai's, so the title half is skipped (codex-chat-sessions D8).
    const codex = record.runtime === 'codex'
    const filePath = this.receiptTranscript(sessionId)
    if (!filePath) {
      const base = this.options.titleLocateIntervalMs ?? 2_000
      const timer = setTimeout(
        () => {
          this.titleWatchers.delete(sessionId)
          this.watchSessionTitle(sessionId, attempt + 1)
        },
        Math.min(base * 2 ** Math.min(attempt, 3), base * 7.5)
      )
      timer.unref?.()
      this.titleWatchers.set(sessionId, { close: () => clearTimeout(timer) })
      return
    }
    const parse = codex ? codexReceiptMessageId : receiptMessageId
    const watcher: TranscriptTitleWatcher = watchTranscriptTitle(
      filePath,
      (title, source) => { if (!codex) this.applyTranscriptTitle(sessionId, title, source) },
      line => {
        const id = parse(line)
        if (!id) return
        const message = this.mailbox.store.get(id)
        if (message?.claimedBy === sessionId) this.mailbox.store.markDelivered(id)
      }
    )
    this.titleWatchers.set(sessionId, watcher)
  }

  /**
   * The file a session's mail receipts are read from: a Codex chat's stored
   * rollout (`transcript_path`, D8), else the Claude transcript found by
   * its SDK id. Sync discovery is fine: a per-event lookup, not the boot
   * path (async-transcript-parsing design D4).
   */
  private receiptTranscript(sessionId: string): string | null {
    const record = this.records.get(sessionId)
    if (!record?.sdkSessionId) return null
    // A missing file reads null either way: uncertain for a receipt, retried by the tail.
    if (record.runtime === 'codex') return record.transcriptPath && existsSync(record.transcriptPath) ? record.transcriptPath : null
    return findTranscriptPath(record.sdkSessionId)
  }

  /** Stop following a session's transcript (kill, archive, shutdown). */
  private releaseTitleWatch(sessionId: string): void {
    this.titleWatchers.get(sessionId)?.close()
    this.titleWatchers.delete(sessionId)
  }

  private async ensureDriver(
    sessionId: string
  ): Promise<ChatAgentDriver | null> {
    const existing = this.drivers.get(sessionId)
    if (existing) {
      if (existing.isDead) {
        const record = this.records.get(sessionId)
        const launch = this.launchFor(record?.claudeProfileId, record?.projectPath)
        // A Codex chat gates on its stored home (runtime/home/login); the
        // Claude executable and auth never apply to it.
        if (record?.runtime === 'codex') {
          const refusal = this.codexStartRefusal(record, launch)
          if (refusal) throw new Error(refusal)
        } else {
          if (launch.runtime === 'claude' && launch.executable) {
            verifyProfileExecutable(record?.claudeProfileId ?? 'default', launch.executable)
          } else {
            // The executable may have been removed or moved since the last
            // spawn: surface a failure now, and respawn the path just verified.
            const executable = await this.checkExecutable()
            existing.setClaudeExecutablePath?.(executable?.path)
          }
          const authRefusal = this.authRefusal(record?.claudeProfileId, record?.projectPath)
          if (authRefusal) throw new Error(authRefusal)
        }
      }
      return existing
    }
    const pending = this.driverPromises.get(sessionId)
    if (pending) return pending
    const record = this.records.get(sessionId)
    if (!record) return null
    // The single guard for every would-be spawn path (design D2 risk): an
    // archived session must never start an agent process.
    if (record.archivedAt != null) throw new Error(ARCHIVED_SESSION_ERROR)
    const launch = this.launchFor(record.claudeProfileId, record.projectPath)
    // Codex chats gate on their stored home (spec "Login lost after
    // creation"); the Claude executable and auth never apply to them.
    if (record.runtime === 'codex') {
      const refusal = this.codexStartRefusal(record, launch)
      if (refusal) throw new Error(refusal)
    } else {
      if (launch.runtime === 'claude' && launch.executable) {
        verifyProfileExecutable(record.claudeProfileId ?? 'default', launch.executable)
      }
      const authRefusal = this.authRefusal(record.claudeProfileId, record.projectPath)
      if (authRefusal) throw new Error(authRefusal)
    }
    // Agent start is one of the account-notice check points (notification
    // strip design D3).
    this.refreshAccountNotice(record.sessionId)
    const promise = (async () => {
      // A Codex chat runs the app-server driver (codex-chat-sessions 5.6);
      // the fixture seam (an injected fake runtime) keeps the fake SDK
      // driver, which starts no Codex child — unless the e2e carve-out
      // configures a Codex executable, and the app-server driver runs.
      const codex = record.runtime === 'codex' && this.codexGatesApply()
      // A profile executable replaces the standard binary (already verified
      // above); otherwise every Claude spawn runs the checked Claude Code
      // install, and a Codex spawn the gated Codex executable.
      const codexExecutable = codex ? (await ensureCodexExecutable()).path : null
      const executable =
        codex || (launch.runtime === 'claude' && launch.executable) ? null : await this.checkExecutable()
      const queryFactory = codex ? null : await this.resolveQueryFactory()
      // The team must be known before the first spawn reads its prompt.
      await this.teams.track(record.sessionId, this.records.get(record.sessionId)?.projectPath ?? record.projectPath)
      // Both runtimes build their team tools from one table (D6).
      const teamServices = this.teamServices()
      const teamMcpServer = codex ? null : await createMailboxServer(this.mailbox, record.sessionId, teamServices)
      // The options both runtimes share: identity, the audit observer, the
      // prompt/effort/policy readers, and every output callback.
      const shared: ChatDriverSharedOptions = {
        sessionId: record.sessionId,
        projectPath: record.projectPath,
        // The session's observer (D7) constructs in src/server/outbound/;
        // the manager registers it with its own live context getters. Its
        // writes notify the team's views only when a row was committed (D9).
        outbound: this.trackObserver(record.sessionId, sessionObserver({
          sessionId: record.sessionId,
          store: recordingStore(this.outboundStore, teamId => this.options.onOutboundChange?.(teamId)),
          destinations: this.outbound,
          repos: this.outboundRepoFacts,
          context: () => {
            const live = this.records.get(record.sessionId)
            return {
              ...(live?.groupId != null ? { groupId: live.groupId } : {}),
              ...(live?.claudeProfileId != null ? { profileId: live.claudeProfileId } : {}),
              ...(live?.taskId != null ? { taskId: live.taskId } : {}),
            }
          },
          teamIdFallback: () => this.teams.teamOf(record.sessionId)?.teamId ?? '',
        })),
        getSystemPromptAppend: () => this.teams.promptFor(
          record.sessionId,
          this.records.get(record.sessionId)?.groupId
        ),
        getEffort: () => this.teams.effortFor(
          record.sessionId,
          this.records.get(record.sessionId)?.groupId,
          this.records.get(record.sessionId)?.claudeProfileId ?? 'default'
        ),
        onSpawn: info => this.recordAgentStart(record.sessionId, info),
        // Read per request so a live policy switch reaches the next
        // canUseTool call without a respawn (design D2).
        getApprovalPolicy: () =>
          this.records.get(record.sessionId)?.approvalPolicy ?? 'manual',
        onEvent: (event) => this.handleDriverEvent(record.sessionId, event),
        onCommandState: (state) =>
          this.options.onCommandState?.(record.sessionId, state),
        onActivity: (activity) =>
          this.handleDriverActivity(record.sessionId, activity),
        onNotification: (notification, timeoutMs) =>
          this.handleDriverNotification(record.sessionId, notification, timeoutMs),
        // An unexpected exit ends the process but not the session: the same
        // driver respawns internally on the next send/start, so the notices
        // die here (design D4) instead of surviving into the replacement.
        onProcessEnd: () => {
          this.observations.chat.processEnded(record.sessionId)
          this.clearAgentNotices(record.sessionId, { emit: true })
        },
        onCompaction: (data, sourceId) => this.observations.chat.compaction(record.sessionId, data, sourceId),
        onWorkers: (workers) =>
          this.handleDriverWorkers(record.sessionId, workers),
        onBackgroundTasks: (tasks) =>
          this.handleDriverBackgroundTasks(record.sessionId, tasks),
        onContextUsage: (usage, opts) =>
          this.handleDriverContextUsage(record.sessionId, usage, opts),
        onModel: (model) => this.handleDriverModel(record.sessionId, model),
        // Plan usage is recorded against the session's provider
        // (providers-and-workers 5.1); the store's change listener drives
        // the onUsage broadcast.
        onRateLimit: (report) =>
          this.recordProviderReport(record, report),
        onUsageReport: (report) =>
          this.recordProviderReport(record, report),
        onUsageNoData: () =>
          this.usageLimits.recordNoData(this.providerIdOf(record.sessionId)),
        onStatus: (status) => this.applyPatch(record.sessionId, { status }),
        onSdkSessionId: (sdkSessionId) =>
          // Persist immediately: a crash right after the first turn must not
          // lose the ability to resume the conversation.
          this.applyPatch(record.sessionId, { sdkSessionId }),
        // A Codex thread's rollout file (design D8), stored for replay.
        onTranscriptPath: (transcriptPath) => this.applyPatch(record.sessionId, { transcriptPath }),
        onCwdChanged: (newCwd) =>
          this.handleDriverCwdChanged(record.sessionId, newCwd),
        // Profile routing (design D6): limit failures count against the
        // session's profile, with its current group for context. A gateway
        // that writes its reset into the error text without a zone is read in
        // the profile's `limitResetTimeZone`.
        onLimitEvent: (signal) => {
          const profileId = record.claudeProfileId ?? 'default'
          const projectPath = this.records.get(record.sessionId)?.projectPath ?? record.projectPath
          this.teamMail.limits.record({
            ...withTextReset(signal, profileLimitResetTimeZone(profileId, this.catalogCtx(projectPath))),
            profileId,
            sessionId: record.sessionId,
            groupId: this.records.get(record.sessionId)?.groupId ?? null,
            // The provider owning the profile at its project path (D7/D10);
            // a Codex login limit records once for the home, the session's
            // own budget for the profile alone (codex-chat-sessions D9).
            providerId: codexLimitProviderId(signal.kind, providerOf(profileId, this.catalogCtx(projectPath))),
            window: signal.window,
          })
        },
      }
      const wire = this.options.wireLogs?.get(record.sessionId)
      // The gates above guarantee a Codex launch with the stored home.
      const codexLaunch = codex && launch.runtime === 'codex' && record.codexHome ? { ...launch, codexHome: record.codexHome } : null
      if (codex && !codexLaunch) throw new Error('Cannot start the agent: this chat\'s Codex profile no longer resolves')
      const driver = codexLaunch
        ? createChatDriver({
            runtime: 'codex',
            options: {
              ...shared,
              executable: codexExecutable!,
              codexHome: codexLaunch.codexHome,
              network: codexLaunch.network,
              ...(codexLaunch.model ? { model: codexLaunch.model } : {}),
              wire: wire ?? { record: () => {} },
              // The registered-name set at the chat's path (D3/D2): a
              // per-spawn provider, so a respawn re-derives the catalog's
              // names plus the retained ones (correction A) — a name
              // registered after this driver's creation still withholds.
              withheldCredentials: () => withheldCredentialNamesAt(this.catalogCtx(record.projectPath), this.options.db),
              teamTools: teamToolTable(this.mailbox, record.sessionId, teamServices),
              // Codex fills a home holding no report with one read (PR E
              // 7.1); the store claims it once per home.
              claimRateLimitsRead: () => this.usageLimits.claimPull(this.providerIdOf(record.sessionId)),
              ...(record.sdkSessionId ? { resumeThreadId: record.sdkSessionId } : {}),
            },
          })
        : createChatDriver({
            runtime: 'claude',
            options: {
              ...shared,
              queryFactory: queryFactory!,
              // The wait is read per question through this getter, so a
              // setting change reaches the next question without rebuilding
              // the driver (question-auto-answer D5, hazard M1).
              getQuestionAutoAnswerMs: () =>
                (this.options.getQuestionAutoAnswerMinutes?.() ?? 0) * 60_000,
              ...(teamMcpServer ? { teamMcpServer } : {}),
              getProviderEnv: () => this.providerEnv(),
              // The secret-name registry observes and persists at every
              // Claude spawn (provider-relay-setup D2), so a name once seen
              // survives its catalog entry's removal.
              retainedNamesDb: this.options.db,
              claudeProfileId: record.claudeProfileId,
              ...(this.options.profileCatalogHome
                ? { profileCatalogHome: this.options.profileCatalogHome }
                : {}),
              ...(executable ? { claudeExecutablePath: executable.path } : {}),
              ...(wire ? { wire } : {}),
              ...(record.sdkSessionId
                ? { resumeSessionId: record.sdkSessionId }
                : {}),
              // Workers design D6: a fresh driver carries the recovered rows, so a
              // restart or archive/restore keeps earlier outcomes in the roster and
              // the sidecar instead of replacing them with an empty one.
              ...(this.workerRows.has(record.sessionId)
                ? { recoveredWorkers: this.workerRows.get(record.sessionId) ?? [] }
                : {}),
              ...(this.backgroundTaskRecords.has(record.sessionId)
                ? { recoveredBackgroundTasks: this.backgroundTaskRecords.get(record.sessionId) ?? [] }
                : {}),
              // The context store's record (plan-workspace §4 S4): the one
              // DB write a contextual submit makes, inside the driver's
              // mint→record→open→emit→enqueue order.
              recordWorkspaceContext: input => this.planWorkspaceContext.record(input),
              // The SDK's usage pull is Claude's alone (providers-and-workers).
              claimUsagePull: () =>
                this.claimProviderUsagePull(record),
            },
          })
      if (
        !this.records.has(record.sessionId) ||
        // Archived while the import was resolving: same discard as kill.
        this.records.get(record.sessionId)?.archivedAt != null
      ) {
        driver.kill()
        this.observations.chat.processEnded(sessionId)
        return null
      }
      // A fresh process starts with a clean notice slate (design D4): any
      // notices left from the crashed predecessor it replaces are gone.
      this.clearAgentNotices(record.sessionId, { emit: true })
      this.drivers.set(record.sessionId, driver)
      // A restored conversation already has a transcript: its title tail
      // starts with the (re)spawn, before any attach or send.
      if (record.sdkSessionId) this.watchSessionTitle(record.sessionId)
      return driver
    })()
    this.driverPromises.set(sessionId, promise)
    try {
      return await promise
    } finally {
      this.driverPromises.delete(sessionId)
    }
  }

  /**
   * Verify the executable, then the SDK handshake, under the resolved launch
   * configuration. The probe cache key includes the executable identity
   * (path + realpath + mtime), so an upgraded executable re-probes the
   * handshake even when the provider configuration is unchanged.
   */
  private async probeAvailability(profileId: string = 'default', projectPath?: string): Promise<void> {
    const providerEnv = this.providerEnv()
    const launch = this.launchFor(profileId, projectPath)
    // Only Claude chats probe the SDK handshake; a Codex chat returns from
    // createAvailableSession before this runs.
    if (launch.runtime !== 'claude') return
    // A profile executable replaces the standard binary; verify it the same
    // way creation would so the probe failure is the actionable one.
    if (launch.executable) verifyProfileExecutable(profileId, launch.executable)
    const executable = launch.executable ? null : await this.checkExecutable()
    const key = executable
      ? `${claudeLaunchKey(launch)}\0${executable.identity}`
      : claudeLaunchKey(launch)
    const cached = this.availability.get(key)
    if (cached) return cached
    const probe = this.options.availabilityProbe ??
      (this.options.queryFactory ? async () => {} : probeSdkAvailability)
    const promise = probe(providerEnv, launch, launch.executable ?? executable?.path)
    // Bound retained configurations; evicted successful probes can be repeated.
    if (this.availability.size >= 32) this.availability.delete(this.availability.keys().next().value!)
    this.availability.set(key, promise)
    promise.catch(() => {
      if (this.availability.get(key) === promise) this.availability.delete(key)
    })
    return promise
  }

  /**
   * The verified executable every spawn will run, or null when a fake
   * runtime is injected (tests, development fixture) and no executable
   * applies. Throws ClaudeExecutableError verbatim for the caller to report.
   */
  private async checkExecutable(): Promise<ClaudeExecutableCheck | null> {
    if (this.options.executableCheck) return this.options.executableCheck()
    // An injected fake runtime (queryFactory for sends, availabilityProbe for
    // creation) must not require a Claude Code install.
    if (this.options.queryFactory || this.options.availabilityProbe) return null
    return ensureClaudeExecutable()
  }

  private providerEnv(): ChatProviderEnv {
    return this.options.getProviderEnv?.() ?? {}
  }

  /** Catalog lookup context for a session's project path. */
  private catalogCtx(projectPath?: string): ProfileCatalogContext {
    return {
      ...(projectPath ? { projectPath } : {}),
      ...(this.options.profileCatalogHome
        ? { homeDir: this.options.profileCatalogHome }
        : {}),
    }
  }

  /**
   * The runtime facts a profile resolves to now (codex-chat-sessions 3.3,
   * ruling R1): its catalog runtime (`claude` when absent) and, for a Codex
   * profile, the resolved absolute home — resolved exactly as the catalog's
   * own home-provider id is, so the two can never disagree. Null when the
   * profile does not resolve, leaving an unknown profile to its existing
   * error paths.
   */
  private runtimeFactsOf(profileId: string, projectPath: string): { runtime: ChatRuntime; codexHome: string | null } | null {
    const ctx = this.catalogCtx(projectPath)
    const profile = resolvedCatalog(ctx).catalog.profiles.get(profileId)
    if (!profile) return null
    if (profile.runtime !== 'codex') return { runtime: 'claude', codexHome: null }
    return {
      runtime: 'codex',
      codexHome: resolveCodexHome(
        { codexHome: profile.codexHome },
        {
          CODEX_HOME: ctx.serverCodexHome ?? process.env.CODEX_HOME,
          HOME: ctx.homeDir ?? process.env.HOME ?? os.homedir(),
        },
      ),
    }
  }

  /**
   * Launch configuration for a profile at a project path — every resolve site
   * goes through here so catalog file failures are reported (never silently
   * skipped: an invalid file would otherwise launch with inherited settings).
   */
  private launchFor(profileId: string | undefined, projectPath?: string): ChatLaunchConfiguration {
    const report = this.options.catalogErrorLog
      ?? (errors => logger.warn('chat_profile_catalog_errors', { errors }))
    // The registry observes here too (provider-relay-setup D2): a name is
    // registered by the first catalog read that names it, launch or not —
    // an entry removed before any spawn stays withheld.
    return resolveClaudeProfile(profileId, this.providerEnv(), this.catalogCtx(projectPath), report, this.options.db)
  }

  /**
   * Why a profile cannot authenticate, or undefined when it can. A provider
   * naming `authTokenEnv` authenticates only with that variable — never the
   * host login or another credential (openrouter-provider D4).
   */
  private authRefusal(profileId: string = 'default', projectPath?: string): string | undefined {
    if (this.options.authCheck) return this.options.authCheck() ? undefined : chatAuthErrorMessage()
    const credential = profileCredential(profileId, this.catalogCtx(projectPath))
    if (credential) {
      const value = effectiveChatEnv(this.providerEnv())[credential.authTokenEnv]
      return value?.trim()
        ? undefined
        : `Provider ${credential.providerLabel} needs ${credential.authTokenEnv} in the server environment.`
    }
    return hasClaudeAuth(this.launchEnvOf(profileId, projectPath)) ? undefined : chatAuthErrorMessage()
  }

  /**
   * A worker's stored-login key for team_capacity's `sharesLoginWith`
   * (dispatch-worker-choice D6): catalog resolution only, no spawn and no
   * read under the config dir. An unresolvable profile has no key; only the
   * error message is logged, never the environment.
   */
  private loginKeyOf(profileId: string, groupsRoot: string): string | null {
    try {
      return storedLoginKey(this.launchFor(profileId, groupsRoot), effectiveChatEnv(this.providerEnv()))
    } catch (error) {
      logger.warn('team_capacity_login_unresolved', { profileId, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** The services every session's team tools are built from, on both runtimes (codex-chat-sessions D6). */
  private teamServices(): MailboxServerServices {
    return {
      tasks: this.tasks, results: this.results, strategies: this.strategies, plans: this.plans, validation: this.validation, ...(this.decisions ? { decisions: this.decisions } : {}), releases: this.teamMail.releases, management: this.management,
      ...(this.checkpoints ? { checkpoints: this.checkpoints } : {}),
      metrics: { teamOf: id => this.teams.teamOf(id)?.teamId ?? null, reader: this.metrics },
      reports: { caller: id => this.reportCaller(id), service: this.reports },
      capacity: this.capacity,
    }
  }

  /**
   * The effective environment a profile's spawn receives, inheritance
   * expanded: an unset SDK `env` means the child inherits process.env, so the
   * merged view is always process.env plus whatever the launch resolved.
   * Shared by the auth gate and the account-notice credentials check, so the
   * two can never disagree about which login applies. Undefined values
   * (process.env holes) are dropped for the ChatProviderEnv-shaped consumers.
   */
  private launchEnvOf(
    profileId: string | undefined,
    projectPath?: string
  ): Record<string, string> {
    const launch = this.launchFor(profileId, projectPath)
    // Codex homes hold the credentials, never ANTHROPIC_* environment: the
    // Claude credential consumers (account notices, provider usage) see an
    // empty environment for a Codex profile.
    if (launch.runtime === 'codex') return {}
    // A set SDK `env` replaces the child's environment whole (credentials
    // withheld); only an unset one inherits process.env.
    const merged = launch.env ?? effectiveChatEnv({})
    return Object.fromEntries(
      Object.entries(merged).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    )
  }

  // ----------------------------------------------------------- provider usage pull

  /**
   * The gap-fill pull slot (usage bar design D1, provider pull design D4,
   * providers-and-workers 5.1): the provider's one pull per store lifetime.
   * A session whose base URL serves the provider quota endpoint has its
   * provider pulled here, marked routed, and the host-login SDK pull is
   * skipped — its data would only mislead. A provider refusal records the
   * no-data verdict; anything else falls through to the SDK pull exactly as
   * before. An already-routed provider just restarts its refresh timer, so
   * a sibling profile's first session costs no second pull.
   */
  private async claimProviderUsagePull(record: ChatSessionRecord): Promise<boolean> {
    const providerId = this.providerIdOf(record.sessionId)
    if (this.providerUsageProfiles.has(providerId)) {
      this.ensureProviderUsageRefresh(providerId)
      return false
    }
    if (!this.usageLimits.claimPull(providerId)) return false
    const target = this.providerUsageTarget(record)
    // No provider base URL: the endpoint is never contacted, and the SDK
    // pull answers as before.
    if (!target) return true
    const pull = await this.fetchProviderUsage(target)
    // Shutdown settles every callback: nothing publishes past it.
    if (this.isShutDown) return false
    if (pull.ok && 'remainingUsd' in pull) {
      // The OpenRouter endpoint answered (openrouter-provider D6): its own
      // data decides, and no outcome of these pulls ever enables the
      // host-login usage pull.
      this.providerUsageProfiles.add(providerId)
      this.recordOpenRouterPull(providerId, pull)
      this.noteOpenRouterCreditsRefused(providerId, pull, target.balanceKey)
      this.ensureProviderUsageRefresh(providerId)
      return false
    }
    if (!pull.ok && (pull.outcome === 'refused' || pull.outcome === 'failed')) {
      // A failed own-endpoint pull records no data and keeps the host-login
      // pull suppressed, whatever the failure (openrouter-provider D6). The
      // provider still counts as routed with its cadence armed: usage
      // refreshes while sessions are live, so a transient failure only
      // postpones the first meters to the next tick (openrouter-provider F2).
      logger.warn('chat_openrouter_key_pull_failed', {
        providerId,
        outcome: pull.outcome,
        reason: pull.reason,
      })
      this.providerUsageProfiles.add(providerId)
      this.usageLimits.recordNoData(providerId)
      this.ensureProviderUsageRefresh(providerId)
      return false
    }
    if (pull.ok) {
      this.providerUsageProfiles.add(providerId)
      this.usageLimits.record(providerId, pull.report)
      this.ensureProviderUsageRefresh(providerId)
      return false
    }
    if (pull.outcome === 'provider-refused') {
      this.usageLimits.recordNoData(providerId)
      return false
    }
    // Not provider-shaped or unreachable: the host-login SDK pull applies.
    return true
  }

  /**
   * Store one successful OpenRouter pull (openrouter-provider D6): meters
   * recorded, and — from a complete pull only (F3) — the smallest remaining
   * amount fed to the credit-cooldown overlay (D8); a pull without meters
   * (follow-up N3) drops any held report and records the no-data verdict, so
   * a key whose limit was removed stops showing its stale meters.
   */
  private recordOpenRouterPull(providerId: string, pull: OpenRouterUsagePull & { ok: true }): void {
    if (pull.report.windows.length === 0) {
      this.usageLimits.clearAndRecordNoData(providerId, pull.report.receivedAt)
      return
    }
    this.usageLimits.record(providerId, pull.report)
    // Only a complete pull feeds the credit-cooldown overlay (D8): a pull
    // whose credits meter dropped out would read the key meter's larger
    // remainder as credit returning and end a live cooldown with no top-up
    // (openrouter-provider F3). Credits 'skipped' (no balance key) and 'ok'
    // are complete; 'refused' and 'failed' leave the pull partial, its
    // meters still shown but its minimum unread.
    const complete = pull.credits.outcome === 'ok' || pull.credits.outcome === 'skipped'
    if (complete && pull.remainingUsd !== null) {
      this.limitEvents.reportRemainingCredit(providerId, pull.remainingUsd)
    }
  }

  /** Log a credits refusal once per balance-key value, naming the provider, never the key (openrouter-provider D6). */
  private noteOpenRouterCreditsRefused(
    providerId: string,
    pull: OpenRouterUsagePull & { ok: true },
    balanceKey: string | undefined
  ): void {
    if (pull.credits.outcome !== 'refused') return
    const value = balanceKey ?? ''
    if (this.openrouterCreditsRefusals.has(value)) return
    if (this.openrouterCreditsRefusals.size >= 64) this.openrouterCreditsRefusals.clear()
    this.openrouterCreditsRefusals.add(value)
    logger.warn('chat_openrouter_credits_refused', { providerId, reason: pull.credits.reason })
  }

  /**
   * Whether the session's provider is pulled from its own endpoint, so
   * agent-emitted usage reports (which can describe the host claude.ai
   * login) are never kept for it — only its own pulls (openrouter D6).
   */
  private keepsOwnEndpointPullsOnly(record: ChatSessionRecord): boolean {
    const baseUrl = this.launchEnvOf(record.claudeProfileId, record.projectPath).ANTHROPIC_BASE_URL?.trim()
    return baseUrl !== undefined && isOpenRouterBaseUrl(baseUrl)
  }

  private recordProviderReport(record: ChatSessionRecord, report: ChatUsageReport): void {
    if (this.keepsOwnEndpointPullsOnly(record)) return
    this.usageLimits.record(this.providerIdOf(record.sessionId), report)
  }

  /**
   * The quota pull target for a session's profile — the effective base URL
   * and credentials its SDK spawns receive (the same resolution the auth
   * gate and account notices read), or null when the profile has no
   * provider base URL.
   */
  private providerUsageTarget(
    record: ChatSessionRecord
  ): { baseUrl: string; token?: string; balanceKey?: string } | null {
    const env = this.launchEnvOf(record.claudeProfileId, record.projectPath)
    const baseUrl = env.ANTHROPIC_BASE_URL?.trim()
    if (!baseUrl) return null
    const token =
      env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || undefined
    // The credits pull's value comes from the server environment under the
    // provider's `balanceKeyEnv` name (openrouter-provider D6) — the same
    // resolution the auth gate reads. Launch environments withhold
    // credential values, so it is never read from there.
    const balanceKeyEnv = resolvedCatalog(this.catalogCtx(record.projectPath)).catalog.profiles.get(
      record.claudeProfileId ?? 'default'
    )?.balanceKeyEnv
    const balanceKey = balanceKeyEnv
      ? effectiveChatEnv(this.providerEnv())[balanceKeyEnv]?.trim() || undefined
      : undefined
    return { baseUrl, token, balanceKey }
  }

  private fetchProviderUsage(target: { baseUrl: string; token?: string; balanceKey?: string }) {
    if (isOpenRouterBaseUrl(target.baseUrl)) {
      return fetchOpenRouterUsage(
        target.baseUrl,
        target.token,
        target.balanceKey,
        this.options.providerUsageFetch ?? fetch
      )
    }
    return fetchZaiUsage(target.baseUrl, target.token, this.options.providerUsageFetch ?? fetch)
  }

  /**
   * Provider usage has no pushes (provider pull design D5): a timer per
   * routed provider re-pulls on a fixed cadence while at least one session
   * on any of the provider's models has a started agent. A tick without a
   * qualifying session makes no request and stops the timer; the next
   * spawn of a routed provider restarts it.
   */
  private ensureProviderUsageRefresh(providerId: string): void {
    if (this.providerUsageTimers.has(providerId)) return
    const timer = setInterval(
      () => this.refreshProviderUsage(providerId),
      this.providerUsageRefreshMs
    )
    timer.unref?.()
    this.providerUsageTimers.set(providerId, timer)
  }

  private refreshProviderUsage(providerId: string): void {
    if (!this.hasLiveSessionOf(providerId)) {
      const timer = this.providerUsageTimers.get(providerId)
      if (timer) clearInterval(timer)
      this.providerUsageTimers.delete(providerId)
      return
    }
    // The pull runs with one live session's credentials (providers-and-workers
    // 5.2); any live session of the provider resolves the same endpoint. An
    // archived sibling never serves the pull.
    const record = this.liveSessionsOf(providerId)[0]
    if (!record) return
    const target = this.providerUsageTarget(record)
    if (!target) return
    void this.fetchProviderUsage(target).then((pull) => {
      // Shutdown settles every callback (an in-flight refresh dies with it);
      // a failed refresh keeps the held report (store semantics); a lost
      // routing just skips the tick.
      if (this.isShutDown || !pull.ok) return
      if ('remainingUsd' in pull) {
        this.recordOpenRouterPull(providerId, pull)
        this.noteOpenRouterCreditsRefused(providerId, pull, target.balanceKey)
        return
      }
      this.usageLimits.record(providerId, pull.report)
    })
  }

  /** Every non-archived session on one of the provider's models with a live driver (started agent). */
  private liveSessionsOf(providerId: string): ChatSessionRecord[] {
    return [...this.records.values()].filter(
      (record) =>
        this.providerIdOf(record.sessionId) === providerId &&
        !record.archivedAt &&
        this.drivers.has(record.sessionId)
    )
  }

  /** Any non-archived session on one of the provider's models with a live driver (started agent). */
  private hasLiveSessionOf(providerId: string): boolean {
    return this.liveSessionsOf(providerId).length > 0
  }

  /**
   * Schedule one extra pull for a session's provider about 30 s after a
   * costed turn (openrouter D6), at most one per provider per minute. A
   * provider whose own usage endpoint is not selected is never scheduled:
   * quota-serving providers refresh on their cadence alone.
   */
  private schedulePostTurnPull(sessionId: string): void {
    const providerId = this.providerIdOf(sessionId)
    const record = this.records.get(sessionId)
    if (!record || !this.keepsOwnEndpointPullsOnly(record)) return
    const now = Date.now()
    const last = this.postTurnPullFiredAt.get(providerId)
    if (last !== undefined && now - last < 60_000) return
    if (this.postTurnPullTimers.has(providerId)) return
    const timer = setTimeout(() => {
      this.postTurnPullTimers.delete(providerId)
      this.postTurnPullFiredAt.set(providerId, Date.now())
      this.refreshProviderUsage(providerId)
    }, 30_000)
    timer.unref?.()
    this.postTurnPullTimers.set(providerId, timer)
  }

  /** Stop every provider usage refresh timer (server shutdown). */
  private stopProviderUsageRefresh(): void {
    for (const timer of this.providerUsageTimers.values()) clearInterval(timer)
    this.providerUsageTimers.clear()
    for (const timer of this.postTurnPullTimers.values()) clearTimeout(timer)
    this.postTurnPullTimers.clear()
  }

  /**
   * Resolve the SDK query() once per process. The import is dynamic so a
   * missing/broken install surfaces as a send-time error, not a crash; the
   * cache is dropped on failure so a repaired install recovers without a
   * server restart.
   */
  private async resolveQueryFactory(): Promise<ChatQueryFactory> {
    const injected = this.options.queryFactory
    if (injected) return injected
    this.sdkQuery ??= import('@anthropic-ai/claude-agent-sdk').then(
      (sdk) => sdk.query,
      (error) => {
        this.sdkQuery = null
        throw error
      }
    )
    return this.sdkQuery
  }

  private handleDriverEvent(sessionId: string, event: ChatEvent): void {
    if (!this.records.has(sessionId)) return
    const events = this.liveEvents.get(sessionId) ?? []
    event = { ...event, sequence: (events.at(-1)?.sequence ?? 0) + 1 }
    events.push(event)
    this.liveEvents.set(sessionId, events)
    this.options.onEvent(sessionId, event)
    this.observations.chat.event(sessionId, event)
    if (event.type === 'request_resolved') this.dispatcher.notify()
    // Per-turn usage (team-process-metrics D1): pinned at turn start, written
    // at completion. Never worth a turn: a failure is logged and the
    // settlement and bookkeeping below still run.
    if (event.type === 'turn_started' || event.type === 'peer_message' || event.type === 'turn_interrupted' || event.type === 'turn_completed') {
      try {
        this.turnUsageTracker.onEvent(sessionId, event)
        if (event.type === 'turn_completed') this.observations.notify()
      } catch (error) {
        logger.warn('chat_turn_usage_record_failed', { sessionId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Every teamMail call below is guarded (driverMailGuard): their writes run
    // on the shared rollback-journal connection, and a throw here used to
    // escape the driver's emit and kill the process. The settle is retried on
    // the guard's timer; the rest log and continue.
    if (event.type === 'error' || event.type === 'turn_completed') {
      // Every attempt (inline or retried) settles only the claims that exist
      // now — same id, claimant, claimed_at. A session-wide retry would settle
      // mail claimed after the turn end (the dispatcher can claim inside the
      // retry window) and hold it uncertain mid-turn (review B1). A read is
      // not blocked by a RESERVED holder, so the snapshot survives the same
      // contention that failed the settle; if it cannot be read at all the
      // empty list settles nothing and mailbox recovery covers the mail.
      const claims = this.mailGuard.guardResult<ClaimRef[]>([], 'chat_mail_settle_snapshot_failed', () => this.teamMail.claimRefs(sessionId), { sessionId })
      this.mailGuard.settleRecipient(sessionId, () => this.teamMail.settleClaims(claims))
    }
    // The context-exhausted flag (chat-context-exhaustion D3), set or cleared
    // before the mail outcome below reads it. A failed write degrades to a
    // normal turn end (fallback false).
    const exhausted = this.mailGuard.guardResult(false, 'chat_context_exhaustion_track_failed', () => this.trackContextExhaustion(sessionId, event), { sessionId })
    // Profile routing: progress and limit outcomes for the mail a turn handles.
    if (event.type === 'tool_call') {
      this.mailGuard.guard('chat_mail_tool_call_failed', () => this.teamMail.toolCall(sessionId, event.tool, event.input), { sessionId })
    }
    // A trigger marks a turn the agent started itself (limit-outcomes-agent-turns D1).
    if (event.type === 'turn_started') {
      this.mailGuard.guard('chat_mail_turn_started_failed', () => this.teamMail.turnStarted(sessionId, event.trigger !== undefined), { sessionId })
    }
    if (event.type === 'turn_completed') {
      try {
        // An exhausted turn never processed its mail: the exhaustion outcome
        // settles it instead of a limit resolution (chat-context-exhaustion D4).
        if (exhausted) this.teamMail.contextExhausted(sessionId)
        else this.teamMail.turnEnded(sessionId, turnSucceeded(event))
      } catch (error) {
        logger.warn('chat_turn_mail_ended_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        })
      }
    }
    // The morning summary's durable turn-end row (team-workspace D8): only a
    // task-bound session's turn is summary material; the task is the one the
    // session worked under at the moment the turn ended, and only a
    // successful turn counts as finished work. A summary row is never worth
    // a turn: a failing write is logged here and must not skip the
    // bookkeeping below or escape into the driver's emit.
    if (event.type === 'turn_completed') {
      const taskId = this.records.get(sessionId)?.taskId
      if (taskId) {
        try {
          this.turnEnds.record(sessionId, taskId, event.at, turnSucceeded(event))
        } catch (error) {
          logger.warn('chat_turn_end_record_failed', {
            sessionId,
            taskId,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          })
        }
      }
    }
    if (
      event.type === 'turn_completed' ||
      event.type === 'approval_request' ||
      event.type === 'question_request'
    ) {
      this.touch(sessionId)
    }
    // A completed turn that carried a provider-reported cost schedules one
    // extra pull for its provider 30 s later, at most one per provider per
    // minute (openrouter-provider D6).
    if (event.type === 'turn_completed' && typeof event.providerCostUsd === 'number' && Number.isFinite(event.providerCostUsd)) {
      this.schedulePostTurnPull(sessionId)
    }
    // Context-usage write points (design D5): a turn boundary, the compaction
    // notice (the driver's compact_boundary), and an error — the visible
    // signal of driver death. Never per assistant frame. The compaction
    // notice is identified by its `kind`, not its display text, so rewording
    // the copy cannot silently stop the write.
    if (
      event.type === 'turn_completed' ||
      event.type === 'error' ||
      (event.type === 'notice' && event.kind === 'compacted')
    ) {
      this.persistContextUsage(sessionId)
    }
  }

  /**
   * Flag a session whose turn failed on a context limit, and clear the flag
   * on the compaction notice or a successful turn (chat-context-exhaustion
   * D3). The column is the truth: nothing re-derives it at startup. Returns
   * whether the event ended an exhausted turn (its mail takes the exhaustion
   * outcome, D4).
   */
  private trackContextExhaustion(sessionId: string, event: ChatEvent): boolean {
    const flagged = this.records.get(sessionId)?.contextExhausted ?? null
    if (event.type === 'turn_completed') {
      if (turnSucceeded(event)) {
        if (flagged) this.applyPatch(sessionId, { contextExhausted: null })
      } else if (event.terminalReason && EXHAUSTING_REASONS.includes(event.terminalReason)) {
        // One episode per flag: a repeated exhausted turn keeps the first flag.
        if (!flagged) this.applyPatch(sessionId, { contextExhausted: { at: event.at || new Date().toISOString(), reason: event.terminalReason } })
        return true
      }
    } else if (event.type === 'notice' && event.kind === 'compacted' && flagged) {
      this.applyPatch(sessionId, { contextExhausted: null })
    }
    return false
  }

  /**
   * Hold the latest reading (design D5) and forward it to the broadcast sink;
   * persistence is throttled to the boundary events above — except when the
   * driver asks for a write now (`persist`): the turn-boundary probe resolves
   * after `turn_completed` has already written the reading, and an abrupt
   * restart would otherwise restore a different threshold (and percentage)
   * than the one last displayed. Those are probe answers, spawn-time
   * re-anchors, and compaction, so they do not reintroduce per-frame churn.
   * A null usage clears the reading (a conversation reset leaves nothing
   * measured) and is persisted as such so a restart cannot restore it.
   */
  private handleDriverContextUsage(
    sessionId: string,
    usage: ChatContextUsage | null,
    opts?: { persist?: boolean; thresholdSource?: string }
  ): void {
    if (!this.records.has(sessionId)) return
    if (usage === null) {
      this.contextReadings.delete(sessionId)
      this.observations.chat.context(sessionId, null, true)
      this.options.onContextUsage?.(sessionId, null)
      this.applyPatch(sessionId, { contextUsage: null })
      return
    }
    this.contextReadings.set(sessionId, usage)
    this.observations.chat.context(sessionId, usage, opts?.persist === true, opts?.thresholdSource)
    this.options.onContextUsage?.(sessionId, usage)
    if (opts?.persist) this.persistContextUsage(sessionId)
  }

  /** Write the freshest in-memory reading to the record, if one exists. */
  private persistContextUsage(sessionId: string): void {
    const usage = this.contextReadings.get(sessionId)
    if (!usage) return
    this.applyPatch(sessionId, { contextUsage: usage })
  }

  /**
   * The driver reported a model different from the last one (chat-session-model
   * design D5): record and persist it right away — model changes are rare (a
   * /model switch), so there is no per-request churn to batch, and a crash
   * before the next boundary must not lose the switch — then hand it to the
   * broadcast sink. The driver already deduped, so this runs per change.
   */
  private handleDriverModel(sessionId: string, model: string): void {
    if (!this.records.has(sessionId)) return
    this.applyPatch(sessionId, { model })
    this.options.onModel?.(sessionId, model)
  }

  /**
   * The agent's working directory moved (worktree tracking design D2): the
   * session row follows it in place — every consumer reads projectPath — and
   * the live driver learns it so any respawn resumes in the directory the
   * conversation is actually in, not the creation path. No-ops when the path
   * is unchanged, so hook noise for the same directory never writes.
   */
  private handleDriverCwdChanged(sessionId: string, newCwd: string): void {
    const record = this.records.get(sessionId)
    if (!record || record.projectPath === newCwd) return
    this.applyPatch(sessionId, { projectPath: newCwd })
    this.drivers.get(sessionId)?.setProjectPath(newCwd)
    this.scheduleCwdRefresh(sessionId, newCwd)
  }

  /**
   * One scoped discovery pass per debounce window (design D2): a fast cd chain
   * collapses into a single refresh for its final directory, so a newly
   * entered worktree is discovered without a reload while its creation does
   * not stampede the coordinator.
   */
  private scheduleCwdRefresh(sessionId: string, path: string): void {
    const pending = this.cwdRefreshTimers.get(sessionId)
    if (pending) clearTimeout(pending.timer)
    const timer = setTimeout(() => {
      this.cwdRefreshTimers.delete(sessionId)
      this.options.requestWorkspaceRefresh?.(path)
    }, this.options.cwdRefreshDebounceMs ?? 500)
    timer.unref?.()
    this.cwdRefreshTimers.set(sessionId, { timer, path })
  }

  /** Forget a session's pending refresh (kill, shutdown). */
  private cancelCwdRefresh(sessionId: string): void {
    const pending = this.cwdRefreshTimers.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.cwdRefreshTimers.delete(sessionId)
  }

  /**
   * Store the latest activity (anchored on this server's clock) and forward
   * it to the broadcast sink. Null (turn end, driver death) clears it.
   */
  private handleDriverActivity(
    sessionId: string,
    activity: ChatActivity | null
  ): void {
    if (!this.records.has(sessionId)) return
    if (activity === null) {
      this.activities.delete(sessionId)
    } else {
      const { elapsedMs, ...body } = activity
      this.activities.set(sessionId, {
        body,
        phaseStartedAt: Date.now() - elapsedMs,
      })
    }
    this.observations.chat.activity(sessionId, activity)
    this.options.onActivity?.(sessionId, activity)
  }

  /** Forget a session's activity, broadcasting null if one was showing. */
  private clearActivity(sessionId: string): void {
    if (this.activities.delete(sessionId)) {
      this.options.onActivity?.(sessionId, null)
    }
  }

  /**
   * Hold the latest roster (design D2) and forward it to the broadcast sink.
   * The sidecar write (design D6) is keyed on the persisted shape, so this
   * fires on every publish but only touches the disk when a row's identity
   * or outcome changed — spawn, fill, settle. Write failures are logged by
   * the store and never fail the session.
   */
  /**
   * Hold the latest background-task roster (design D2) and forward it to the
   * broadcast sink. The sidecar write (design D6) is keyed on the persisted
   * shape, so `live` toggles never touch the disk; write failures are
   * logged by the store and never fail the session.
   */
  private handleDriverBackgroundTasks(sessionId: string, tasks: ChatBackgroundTask[]): void {
    if (!this.records.has(sessionId)) return
    this.backgroundTaskRows.set(sessionId, tasks)
    this.options.onBackgroundTasks?.(sessionId, tasks)
    this.rosterChanged(sessionId)
    const store = this.options.taskStore
    const driver = this.drivers.get(sessionId)
    if (!driver) return
    // A crashing driver is already dead when process_end publishes stopped
    // tasks. Save those final records so archive/restore cannot revive them.
    const records = driver.getBackgroundTaskRecords()
    this.backgroundTaskRecords.set(sessionId, records)
    if (store) {
      store.write(sessionId, records).catch((error) => {
        logger.warn('chat_task_sidecar_write_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  private handleDriverWorkers(sessionId: string, workers: ChatWorker[]): void {
    if (!this.records.has(sessionId)) return
    this.workerRows.set(sessionId, workers)
    this.options.onWorkers?.(sessionId, workers)
    this.rosterChanged(sessionId)
    const store = this.options.workerStore
    if (store) {
      store.write(sessionId, workers).catch((error) => {
        logger.warn('chat_worker_sidecar_write_failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  /** Bump lastActivity across record, db, and registry in one update. */
  private touch(sessionId: string): void {
    this.applyPatch(sessionId, { lastActivityAt: new Date().toISOString() })
  }

  /**
   * Record the session's current name and group under its team. The team is
   * resolved asynchronously, so this runs again from `onResolved`; with no
   * team yet there is nothing to record. Called from detached callbacks that
   * can land after teardown has closed the database — a lost last-known-name
   * write is preferable to an unhandled rejection, so the write is best-effort.
   */
  private syncDirectory(sessionId: string): void {
    if (this.isShutDown) return
    const record = this.records.get(sessionId)
    const teamId = this.teams.teamOf(sessionId)?.teamId
    if (!record || !teamId) return
    try {
      this.directory.upsert(teamId, {
        sessionId,
        name: record.name,
        group: record.groupId ?? null,
      })
    } catch {
      // Teardown closed the database under an in-flight team resolution.
    }
  }

  private applyPatch(
    sessionId: string,
    patch: Partial<ChatSessionRecord>
  ): void {
    const record = this.records.get(sessionId)
    if (!record) return
    const next = { ...record, ...patch }
    this.records.set(sessionId, next)
    // Keep the directory's last known name and group (team-message-threads
    // D3); kill and archive deliberately never write here.
    if (patch.name !== undefined || patch.groupId !== undefined) this.syncDirectory(sessionId)
    if (
      (patch.status !== undefined && patch.status !== record.status) ||
      patch.projectPath !== undefined || patch.archivedAt !== undefined ||
      patch.contextExhausted !== undefined ||
      (patch.sdkSessionId !== undefined && patch.sdkSessionId !== record.sdkSessionId)
    ) this.dispatcher?.notify()
    // Fields a team view shows (team-workspace: live membership); other
    // patches (usage, activity stamps) stay silent.
    if (
      patch.status !== undefined || patch.archivedAt !== undefined || patch.projectPath !== undefined ||
      patch.name !== undefined || patch.groupId !== undefined || patch.taskId !== undefined ||
      patch.contextExhausted !== undefined
    ) this.options.onSessionRecordChange?.(sessionId)
    this.options.db.updateChatSession(sessionId, patch)
    // The first SDK session id makes a transcript followable: start the
    // title tail for the now-live conversation (design D4).
    if (patch.sdkSessionId !== undefined) {
      this.watchSessionTitle(sessionId)
    }
    // A Codex rollout path that is new or moved (D8): the receipt tail
    // follows the stored file from now on.
    if (patch.transcriptPath !== undefined && patch.transcriptPath !== record.transcriptPath) {
      this.releaseTitleWatch(sessionId)
      this.watchSessionTitle(sessionId)
    }
    // A moved cwd may leave the team (another repository); re-resolve.
    if (patch.projectPath !== undefined) void this.teams.track(sessionId, patch.projectPath)
    this.options.registry.updateSession(sessionId, {
      // Status changes re-read the group file, so a removed or restored
      // group shows in the navigator without a restart.
      ...(patch.status !== undefined ? this.groupFields(next) : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      // The agent's cwd move rides the same session-update broadcast, so
      // clients re-group the row without a reload (worktree tracking D2).
      ...(patch.projectPath !== undefined
        ? { projectPath: patch.projectPath }
        : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.lastActivityAt !== undefined
        ? { lastActivity: patch.lastActivityAt }
        : {}),
      ...(patch.archivedAt !== undefined ? { archivedAt: patch.archivedAt } : {}),
      ...(patch.approvalPolicy !== undefined
        ? { approvalPolicy: patch.approvalPolicy }
        : {}),
      ...(patch.nameSource !== undefined
        ? { nameSource: patch.nameSource }
        : {}),
      ...(patch.taskId !== undefined ? this.taskFields(next) : {}),
      ...(patch.contextExhausted !== undefined ? { contextExhausted: patch.contextExhausted } : {}),
    })
  }

  private toSession(record: ChatSessionRecord): Session {
    return {
      id: record.sessionId,
      name: record.name,
      kind: 'chat',
      claudeProfileId: record.claudeProfileId ?? 'default',
      approvalPolicy: record.approvalPolicy ?? 'manual',
      // The runtime is fixed at creation (R1); absent = claude, so the
      // Debug view reads the record instead of the live catalog (N4).
      ...(record.runtime === 'codex' ? { runtime: record.runtime } : {}),
      // Absent provenance is treated as manual: a name we cannot attribute is
      // never handed over to a generated title (chat-session-naming design D6).
      nameSource: record.nameSource ?? 'manual',
      projectPath: record.projectPath,
      status: record.status,
      lastActivity: record.lastActivityAt,
      createdAt: record.createdAt,
      source: 'managed',
      // Per design D1: existing icons, labels, and sorting keep working.
      agentType: 'claude',
      ...(record.archivedAt != null ? { archivedAt: record.archivedAt } : {}),
      ...this.groupFields(record),
      ...this.taskFields(record),
      ...(record.spawned ? { spawned: true } : {}),
      ...(this.parkedShown.has(record.sessionId) ? { parked: this.parkedShown.get(record.sessionId)! } : {}),
      ...(record.contextExhausted ? { contextExhausted: record.contextExhausted } : {}),
    }
  }

  /** Associated task id plus its current title (team-tasks header). */
  private taskFields(record: ChatSessionRecord): Partial<Session> {
    if (record.taskId == null) return {}
    const title = this.tasks.store.get(record.taskId)?.title
    return { taskId: record.taskId, ...(title !== undefined ? { taskTitle: title } : {}) }
  }

  /** Group id plus display state; label/missing only once the team is known. */
  private groupFields(record: ChatSessionRecord): Partial<Session> {
    if (record.groupId == null) return {}
    const info = this.teams.groupInfo(record.sessionId, record.groupId)
    return {
      groupId: record.groupId,
      ...(info ? { groupLabel: info.label, groupMissing: info.missing } : {}),
    }
  }
}
