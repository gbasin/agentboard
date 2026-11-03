// Codex chat lifecycle: one app-server child and persisted thread per session.
// Kawai owns turn ids; text/tool events, approvals, activity, and audit map
// through the Codex adapters. A send during a turn steers it; process death
// permits respawn/resume. CodexCommandDiscovery owns detached skill discovery
// and its loading/ready/unavailable command catalog (autocomplete D1/D2).
import type {
  ChatApprovalDecision,
  ChatApprovalPolicy,
  ChatBackgroundTask,
  ChatCommandState,
  ChatPeerMessage,
  ChatPendingRequest,
  ChatQuestionAnswer,
  ChatTurnTrigger,
  ChatWorker,
} from '../../../shared/chat'
import type { SessionStatus } from '../../../shared/types'
import { logger } from '../../logger'
import { formatEnvelope } from '../../team/envelope'
import { initialChatActivityState, type ChatActivityInput } from '../chatActivity'
import type { BackgroundTaskRecord } from '../chatBackgroundTasks'
import { codexSpawnEnv } from '../codexProfiles'
import type { ChatAgentDriver, ChatDriverCallbacks } from '../provider/driver'
import { activityFrameFor, publishCodexActivity } from './codexActivity'
import { AppServerClient, type AppServerClientOptions, type AppServerExit } from './appServerClient'
import { auditDeniedCard, auditItem, auditSpawnEnd } from './codexAudit'
import { dispatchTeamToolCall, teamNamespaceSpec } from './codexTools'
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams'
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import { mapCodexNotification, turnCompletedDrafts, turnUsageBetween, type CodexEventDraft, type CodexOutput } from './codexEvents'
import { CodexRequests } from './codexRequests'
import { CodexCommandDiscovery } from './CodexCommandDiscovery'
import type { CodexSkillInput } from './codexCommands'
import { answerAsyncQuestion, CLIENT_INFO, codexContextUsage, codexEffort, reportCompaction, reportSpawn, threadParams, type CodexClient, type CodexSessionDriverOptions } from './codexThread'
import { codexRetryLimitSignal, codexTurnLimitSignal } from './codexLimits'
import { normalizeRateLimitSnapshot, snapshotOfRateLimitsRead } from './codexUsage'
import type { RateLimitSnapshot } from './protocol/v2/RateLimitSnapshot'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import type { TokenUsageBreakdown } from './protocol/v2/TokenUsageBreakdown'
import type { Turn } from './protocol/v2/Turn'

export { codexEffort, type CodexSessionDriverOptions } from './codexThread'

export class CodexSessionDriver implements ChatAgentDriver {
  private client: CodexClient | null = null
  /** Resolves once the thread is started or resumed on the current client. */
  private ready: Promise<boolean> = Promise.resolve(false)
  private threadId: string | null
  private dead = false
  private killed = false
  private sequence = 0
  private activeTurnId: string | null = null
  private codexTurnId: string | null = null
  /** A turn/start in flight, so interrupt can learn the Codex turn id. */
  private turnStarting: Promise<void> | null = null
  /** Interrupted Codex turns whose late frames and completion are dropped. */
  private readonly interrupted = new Set<string>()
  private lastStatus: SessionStatus | null = null
  private activity = initialChatActivityState()
  private spawnId = 'ob-s-none'
  private projectPath: string
  private readonly seenToolCallIds = new Set<string>()
  private readonly itemInputs = new Map<string, Record<string, unknown>>()
  private readonly askedItems = new Set<string>()
  private turnStartTotal: TokenUsageBreakdown | null = null
  private latestTotal: TokenUsageBreakdown | null = null
  /** The latest rate-limit snapshot this session received, for the limit reset (PR E 7.2). */
  private latestRateLimits: RateLimitSnapshot | null = null
  private lastModel: string | null = null
  private readonly requests: CodexRequests
  private readonly commands: CodexCommandDiscovery

  constructor(private readonly options: CodexSessionDriverOptions) {
    this.threadId = options.resumeThreadId ?? null
    this.projectPath = options.projectPath
    this.commands = new CodexCommandDiscovery(state => this.options.onCommandState?.(state))
    this.requests = new CodexRequests({
      emit: draft => this.emit(draft),
      refreshStatus: () => this.refreshStatus(),
      policy: () => this.options.getApprovalPolicy?.() ?? 'manual',
      turnId: () => this.activeTurnId ?? this.startTurn({ kind: 'resumed' }),
      itemInput: itemId => this.itemInputs.get(itemId),
      denied: use => auditDeniedCard(this.options.outbound, use, { spawnId: this.spawnId, cwd: this.projectPath }),
    })
  }

  get isDead(): boolean {
    return this.dead
  }

  getCommandState(): ChatCommandState {
    return this.commands.snapshot()
  }

  start(): void {
    if (this.killed) return
    this.ensureClient()
  }

  setProjectPath(path: string): void {
    this.projectPath = path
    this.commands.changeDirectory(path)
  }

  send(text: string): void {
    if (this.killed) return
    const skills = this.commands.inputs(text)
    this.ensureClient()
    const turnId = this.activeTurnId ?? this.startTurn()
    this.emit({ type: 'user_message', turnId, text })
    this.startCodexTurn(text, undefined, skills)
    this.refreshStatus()
  }

  deliver(envelope: ChatPeerMessage): void {
    if (this.killed) throw new Error('Recipient was killed')
    if (this.activeTurnId || this.requests.size) throw new Error('Recipient is not idle')
    this.ensureClient()
    const turnId = this.startTurn()
    this.emit({ type: 'peer_message', turnId, ...envelope })
    this.startCodexTurn(formatEnvelope(envelope), envelope.messageId)
    this.refreshStatus()
  }

  async interrupt(): Promise<void> {
    this.requests.cancelAll()
    const client = this.client
    const starting = this.turnStarting
    if (this.activeTurnId) {
      const turnId = this.activeTurnId
      this.activeTurnId = null
      this.emit({ type: 'turn_interrupted', turnId })
    }
    this.refreshStatus()
    if (!client) return
    if (starting) await starting
    // Killed or exited meanwhile (archive interrupts, then kills at once).
    if (this.client !== client) return
    const codexTurnId = this.codexTurnId
    this.codexTurnId = null
    if (!codexTurnId || !this.threadId) return
    this.interrupted.add(codexTurnId)
    const ack = client.request('turn/interrupt', { threadId: this.threadId, turnId: codexTurnId }).then(() => undefined)
    let timer: NodeJS.Timeout | undefined
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.interruptTimeoutMs ?? 5_000)
      timer.unref?.()
    })
    await Promise.race([ack, bound]).catch(() => {
      // The process may already be gone; the exit handler settles the rest.
    }).finally(() => clearTimeout(timer))
  }

  kill(): void {
    this.killed = true
    this.stop()
  }

  shutdown(): void {
    this.killed = true
    this.stop()
  }

  onApprovalPolicyChanged(policy: ChatApprovalPolicy): void {
    this.requests.policyChanged(policy)
  }

  resolveApproval(requestId: string, decision: ChatApprovalDecision): { ok: true } | { ok: false; error: string } {
    return this.requests.resolveApproval(requestId, decision)
  }

  answerQuestion(requestId: string, answers: Record<string, ChatQuestionAnswer>): { ok: true } | { ok: false; error: string } {
    return this.requests.answerQuestion(requestId, answers)
  }

  holdQuestion(requestId: string): { ok: true } | { ok: false; error: string } {
    return this.requests.holdQuestion(requestId)
  }

  getPendingRequests(): ChatPendingRequest[] {
    return this.requests.snapshot()
  }

  getSeenToolCallIds(): Set<string> {
    return new Set(this.seenToolCallIds)
  }

  // Non-goals for Codex chats (design D7): no worker roster, no background tasks.
  getWorkers(): ChatWorker[] {
    return []
  }

  getBackgroundTasks(): ChatBackgroundTask[] {
    return []
  }

  getBackgroundTaskRecords(): BackgroundTaskRecord[] {
    return []
  }

  getTaskOutput(): Promise<null> {
    return Promise.resolve(null)
  }

  stopTask(): Promise<boolean> {
    return Promise.resolve(false)
  }

  // ---------------------------------------------------------------- internals

  private stop(): void {
    this.commands.stop()
    this.requests.cancelAll()
    if (this.activeTurnId) {
      const turnId = this.activeTurnId
      this.activeTurnId = null
      this.emit({ type: 'turn_interrupted', turnId })
    }
    const client = this.client
    this.client = null
    client?.end()
    if (client) auditSpawnEnd(this.options.outbound, this.spawnId)
    this.refreshStatus()
  }

  private ensureClient(): void {
    this.dead = false
    if (this.client) return
    this.spawnId = `ob-s-${crypto.randomUUID()}`
    // The provider runs per spawn: the registered-name set is re-derived at
    // every (re)start, never frozen at driver creation (correction A).
    const env = codexSpawnEnv(this.options.serverEnv ?? process.env, this.options.codexHome, this.options.withheldCredentials())
    const clientOptions: AppServerClientOptions = {
      executable: this.options.executable,
      env,
      wire: this.options.wire,
      onNotification: (method, params) => {
        if (this.client === client) this.onNotification(method, params)
      },
      onServerRequest: (method, params) => this.onServerRequest(method, params),
      onExit: exit => this.onExit(client, exit),
    }
    const client = (this.options.createClient ?? (o => new AppServerClient(o)))(clientOptions)
    this.client = client
    this.commands.start(client, this.projectPath)
    client.start()
    this.ready = this.boot(client, env)
  }

  /** initialize, then thread/start or thread/resume; false on failure. */
  private async boot(client: CodexClient, env: Record<string, string>): Promise<boolean> {
    const resumed = this.threadId !== null
    const instructions = this.options.getSystemPromptAppend?.() ?? ''
    const effort = this.options.getEffort?.()
    try {
      await client.initialize(CLIENT_INFO)
      const params = await threadParams({ cwd: this.projectPath, network: this.options.network, instructions, model: this.options.model })
      const result = await client.request(
        resumed ? 'thread/resume' : 'thread/start',
        // The team tools register at thread start; a resume serves the set
        // the thread stored (spike: thread/resume takes no dynamicTools).
        // excludeTurns: only the thread's id, path, and model are read, and
        // a long thread's full history arrives as one line of hundreds of MB.
        resumed ? { ...params, threadId: this.threadId, excludeTurns: true } : { ...params, ephemeral: false, ...this.dynamicTools() },
      ) as { thread?: { id?: unknown; path?: unknown }; model?: unknown }
      if (this.client !== client) return false
      const thread = result?.thread
      if (typeof thread?.id !== 'string') throw new Error('Codex app-server returned no thread')
      if (!resumed) {
        this.threadId = thread.id
        this.options.onSdkSessionId?.(thread.id)
      }
      if (typeof thread.path === 'string' && thread.path) this.options.onTranscriptPath?.(thread.path)
      if (typeof result.model === 'string') this.reportModel(result.model)
      reportSpawn(this.options, { cwd: this.projectPath, instructions, effort, env, resumed })
      this.fillRateLimits(client)
      this.commands.ready()
      return true
    } catch (error) {
      if (this.client !== client) return false
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('codex_thread_start_failed', { sessionId: this.options.sessionId, error: message })
      this.emit({ type: 'error', message: `Codex could not ${resumed ? 'resume' : 'start'} the thread: ${message}` })
      this.endActiveTurn()
      this.commands.stop()
      client.end()
      return false
    }
  }

  /**
   * Ask the app-server for a turn once the thread is ready. Delivered mail
   * passes its message id as clientUserMessageId (D8, for debugging only:
   * receipt still comes from the rollout file).
   */
  private startCodexTurn(text: string, clientUserMessageId = `kawai-${crypto.randomUUID()}`, skills: CodexSkillInput[] = []): void {
    const client = this.client
    if (!client) return
    const effort = codexEffort(this.options.getEffort?.())
    const starting = this.ready.then(async (ok) => {
      if (!ok || this.client !== client || !this.threadId) return
      const result = await client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text, text_elements: [] }, ...skills],
        clientUserMessageId,
        ...(effort ? { effort } : {}),
      }) as { turn?: { id?: unknown } }
      const id = result?.turn?.id
      // Bound even when an interrupt already closed the Kawai turn: the
      // interrupt waits for this response to learn which turn to stop.
      if (typeof id === 'string' && !this.interrupted.has(id)) this.codexTurnId ??= id
    }).catch((error: unknown) => {
      if (this.client !== client) return
      this.emit({ type: 'error', message: `Codex refused the turn: ${error instanceof Error ? error.message : String(error)}` })
      this.endActiveTurn()
    }).finally(() => {
      if (this.turnStarting === starting) this.turnStarting = null
    })
    this.turnStarting = starting
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'skills/changed') { this.commands.changed(); return }
    const frameTurn = typeof params.turnId === 'string' ? params.turnId : undefined
    if (frameTurn && this.interrupted.has(frameTurn)) return
    const turnId = this.activeTurnId ?? ''
    if (method === 'error' && params.willRetry === true) {
      this.feedActivity({ type: 'api_retry', attempt: 1, maxRetries: 1 })
      const retry = codexRetryLimitSignal(params, this.latestRateLimits)
      if (retry) this.options.onLimitEvent?.(retry)
    }
    for (const output of mapCodexNotification(method, params, turnId)) this.apply(output, method, params)
  }

  private apply(output: CodexOutput, method: string, params: Record<string, unknown>): void {
    switch (output.kind) {
      case 'turn_started':
        if (this.interrupted.has(output.codexTurnId)) return
        if (!this.activeTurnId) this.startTurn({ kind: 'resumed' })
        this.codexTurnId = output.codexTurnId
        this.turnStartTotal = this.latestTotal
        return
      case 'turn_completed':
        this.completeTurn(output.turn)
        return
      case 'token_usage':
        this.onTokenUsage(output.usage.total, output.usage.last, output.usage.modelContextWindow)
        return
      case 'rate_limits':
        this.latestRateLimits = output.snapshot
        this.options.onRateLimit?.(normalizeRateLimitSnapshot(output.snapshot))
        return
      case 'question': {
        if (this.askedItems.has(output.itemId)) return
        this.askedItems.add(output.itemId)
        this.requests.asyncQuestion(output.questions, text => answerAsyncQuestion(this.client, this.threadId, text))
        return
      }
      case 'compaction':
        this.onCompacted(output.itemId)
        return
      case 'activity':
        this.feedActivity(output.input)
        return
      case 'event': {
        if (!this.activeTurnId) return
        const draft = output.draft
        if (draft.type === 'tool_call') {
          this.seenToolCallIds.add(draft.toolCallId)
          this.itemInputs.set(draft.toolCallId, draft.input as Record<string, unknown>)
        }
        this.emit(draft)
        const item = (params as { item?: ThreadItem }).item
        if (draft.type === 'tool_call' && method === 'item/started') this.audit('started', item)
        if (draft.type === 'tool_result' && method === 'item/completed') this.audit('completed', item)
        return
      }
    }
  }

  private audit(phase: 'started' | 'completed', item: ThreadItem | undefined): void {
    auditItem(phase, item, { sink: this.options.outbound, spawnId: this.spawnId, cwd: this.projectPath })
  }

  /** Fill once per home without a report (PR E 7.1), claimed by the manager. */
  private fillRateLimits(client: CodexClient): void {
    if (!this.options.claimRateLimitsRead?.()) return
    client.request('account/rateLimits/read', {}).then((result) => {
      if (this.client !== client) return
      this.latestRateLimits = snapshotOfRateLimitsRead(result)
      const report = normalizeRateLimitSnapshot(this.latestRateLimits, undefined, 'provider')
      if (report.windows.length > 0) this.options.onRateLimit?.(report)
      else this.options.onUsageNoData?.()
    }).catch(() => {
      // A dead process surfaces through onExit; there is nothing to fill.
      if (this.client === client) this.options.onUsageNoData?.()
    })
  }

  private completeTurn(turn: Turn): void {
    if (this.interrupted.delete(turn.id)) return
    const turnId = this.activeTurnId
    if (!turnId) return
    if (this.codexTurnId && turn.id !== this.codexTurnId) return
    this.activeTurnId = null
    this.codexTurnId = null
    if (turn.status === 'interrupted') {
      this.emit({ type: 'turn_interrupted', turnId })
    } else {
      const limit = codexTurnLimitSignal(turn, this.latestRateLimits)
      if (limit) this.options.onLimitEvent?.(limit)
      for (const draft of turnCompletedDrafts(turn, turnId, turnUsageBetween(this.turnStartTotal, this.latestTotal))) this.emit(draft)
    }
    this.turnStartTotal = this.latestTotal
    this.refreshStatus()
  }

  private onTokenUsage(total: TokenUsageBreakdown, last: TokenUsageBreakdown, window: number | null): void {
    this.latestTotal = total
    if (!window || window <= 0 || !this.options.onContextUsage) return
    this.options.onContextUsage(codexContextUsage(last, window), { thresholdSource: 'model-window-fallback' })
  }

  private onCompacted(itemId: string): void {
    reportCompaction(this.options, itemId)
    this.emit({ type: 'notice', text: 'Context compacted', kind: 'compacted' })
  }

  private onServerRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.requests.handles(method)) return this.requests.serverRequest(method, params)
    if (method === 'item/tool/call') return dispatchTeamToolCall(this.options.teamTools ?? [], this.threadId, params as Partial<DynamicToolCallParams>)
    return Promise.reject(new Error(`Kawai does not handle ${method}`))
  }

  private dynamicTools(): { dynamicTools?: DynamicToolSpec[] } {
    const table = this.options.teamTools
    return table?.length ? { dynamicTools: [teamNamespaceSpec(table)] } : {}
  }

  private onExit(client: CodexClient, exit: AppServerExit): void {
    if (this.client !== client) return
    this.client = null
    this.commands.stop()
    this.dead = true
    this.ready = Promise.resolve(false)
    auditSpawnEnd(this.options.outbound, this.spawnId)
    this.requests.cancelAll()
    this.endActiveTurn()
    this.options.onProcessEnd?.()
    const how = exit.signal ? `on ${exit.signal}` : exit.code !== null ? `with code ${exit.code}` : 'without starting'
    this.emit({ type: 'error', message: `The Codex app-server exited ${how}` })
    this.refreshStatus()
  }

  /** A failed start or a dead process: the open turn ends as an error. */
  private endActiveTurn(): void {
    const turnId = this.activeTurnId
    this.activeTurnId = null
    this.codexTurnId = null
    if (turnId) this.emit({ type: 'turn_completed', turnId, subtype: 'error_during_execution', isError: true })
    this.refreshStatus()
  }

  private startTurn(trigger?: ChatTurnTrigger): string {
    const turnId = this.options.createTurnId?.() ?? `turn-${crypto.randomUUID()}`
    // Per-item state lives one turn (bounded however long the session): an
    // item's approval and question arrive within its turn, and outside a
    // turn no item is recorded. The ids a live replay must not cancel are
    // the open turn's — an ended turn's outcome is final in its rollout.
    this.seenToolCallIds.clear()
    this.itemInputs.clear()
    this.askedItems.clear()
    this.activeTurnId = turnId
    this.emit({ type: 'turn_started', turnId, ...(trigger ? { trigger } : {}) })
    return turnId
  }

  private reportModel(model: string): void {
    if (!model || model === this.lastModel) return
    this.lastModel = model
    this.options.onModel?.(model)
  }

  private refreshStatus(): void {
    const next: SessionStatus = this.requests.size > 0 ? 'permission' : this.activeTurnId ? 'working' : 'waiting'
    if (next === this.lastStatus) return
    this.lastStatus = next
    this.options.onStatus(next)
  }

  private feedActivity(input: ChatActivityInput): void {
    this.activity = publishCodexActivity(this.activity, input, a => this.options.onActivity?.(a))
  }

  private emit(draft: CodexEventDraft): void {
    this.sequence += 1
    this.options.onEvent({ ...draft, id: `evt-${crypto.randomUUID()}`, sequence: this.sequence, at: new Date().toISOString() } as Parameters<ChatDriverCallbacks['onEvent']>[0])
    const frame = activityFrameFor(draft)
    if (frame) this.feedActivity(frame)
  }
}
