/** Coordinate durable launch intents with tmux, including crash reconciliation. */
import type { Session } from '../../shared/types'
import type { SavedSession } from '../../shared/persistence'
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { SessionManager } from '../SessionManager'
import { inferAgentType } from '../agentDetection'
import { generateSessionName } from '../nameGenerator'
import { SessionCatalog, assertSessionName } from './catalog'
import { RequestError, notFound } from './errors'
import { importConversations, importConversation } from './legacyImport'
import {
  provisionalTagFromName,
  readTmuxIdentity,
  tmuxEpochForPid,
  type TmuxIdentity,
  type WindowIdentity,
} from './tmuxIdentity'
import { config } from '../config'
import { logger } from '../logger'

export class PersistentSessions {
  readonly catalog: SessionCatalog
  private snapshot: TmuxIdentity | null = null
  error: string | null = null
  constructor(
    readonly db: SessionDatabase,
    readonly manager: SessionManager,
    hostId: string,
    private readonly identity = () => readTmuxIdentity(config.tmuxSession),
    private readonly epochForPid = tmuxEpochForPid,
    private readonly managedSession = config.tmuxSession
  ) {
    this.catalog = new SessionCatalog(db.db, hostId)
    importConversations(this.catalog, db, this.isManagedWindow)
  }
  /** Windows outside the managed session are never reconciled by the catalog. */
  readonly isManagedWindow = (window: string) =>
    window.startsWith(`${this.managedSession}:`)
  /**
   * Reconcile catalog state against the window list the refresh pipeline
   * already enumerated — the identity tags ride that enumeration, so this
   * snapshot and `sessions` are one consistent read with no extra tmux calls.
   * The server pid identifies the tmux incarnation; an enumeration that
   * cannot report it cannot vouch for window identity either, so pid 0
   * skips reconciliation rather than guessing at stale tags.
   */
  beforeSnapshot(sessions: Session[], serverPid = 0) {
    try {
      const windows = new Map<string, WindowIdentity>()
      for (const live of sessions) {
        if (live.remote || live.source !== 'managed') continue
        const tags = live.agentboardTags
        const launch = provisionalTagFromName(live.name)
        windows.set(
          live.tmuxWindow,
          launch
            ? {
                boardId: tags?.boardId || launch.boardId,
                runId: tags?.runId || launch.runId,
                provisional: true,
              }
            : { boardId: tags?.boardId || '', runId: tags?.runId || '' }
        )
        if (tags?.serverPid) serverPid = tags.serverPid
      }
      if (!serverPid) {
        this.snapshot = null
        return
      }
      const snapshot: TmuxIdentity = {
        epoch: this.epochForPid(serverPid),
        windows,
      }
      this.snapshot = snapshot
      const runs = new Map(
        [...snapshot.windows].map(([window, tag]) => [
          tag.runId,
          { window, boardId: tag.boardId },
        ])
      )
      for (const saved of this.catalog.active()) {
        const match = saved.lastRunId ? runs.get(saved.lastRunId) : undefined
        const window = match && match.boardId === saved.id ? match.window : undefined
        if (saved.requestedState) {
          if (window) {
            this.manager.killWindow(window)
            snapshot.windows.delete(window)
            const index = sessions.findIndex((s) => s.tmuxWindow === window)
            if (index >= 0) sessions.splice(index, 1)
          }
          this.catalog.transition(saved.id, saved.requestedState)
          this.releaseProvider(saved, saved.requestedState === 'hibernating')
          continue
        }
        if (window) {
          if (
            saved.state !== 'running' ||
            saved.window !== window ||
            saved.epoch !== snapshot.epoch
          )
            this.catalog.bind(
              saved.id,
              saved.lastRunId!,
              window,
              snapshot.epoch
            )
          // Self-heal: a running row's conversation must be claimed by its
          // window, or /api/sessions hydration loses its id and transcript.
          this.reclaimProvider(saved.id, window)
          continue
        }
        if (
          saved.epoch !== snapshot.epoch ||
          !saved.window ||
          !snapshot.windows.has(saved.window)
        ) {
          this.catalog.transition(
            saved.id,
            'interrupted',
            'Process stopped unexpectedly'
          )
          this.releaseProvider(saved)
        } else if (
          identityChanged(snapshot.windows.get(saved.window), saved)
        ) {
          this.catalog.transition(
            saved.id,
            'interrupted',
            'Window identity changed'
          )
          this.releaseProvider(saved)
        }
      }
      // Legacy associations from another tmux lifetime must not claim reused IDs.
      const previousEpoch = this.db.getAppSetting('persistence_tmux_epoch')
      if (previousEpoch && previousEpoch !== snapshot.epoch) {
        for (const record of this.db.getActiveSessions())
          this.db.orphanSession(record.sessionId)
      }
      this.db.setAppSetting('persistence_tmux_epoch', snapshot.epoch)
      this.error = null
    } catch (error) {
      this.error = String(error)
      this.snapshot = null
    }
  }
  observe(sessions: Session[]) {
    if (!this.snapshot) return
    for (const live of sessions.filter(
      (s) => !s.remote && s.source === 'managed'
    )) {
      // One bad session (rename collision, stale tag, catalog constraint)
      // must not abort reconciliation for the rest or poison startup.
      try {
        this.observeOne(live)
      } catch (error) {
        this.error = String(error)
      }
    }
    importConversations(this.catalog, this.db, this.isManagedWindow)
  }
  private observeOne(live: Session) {
    const snapshot = this.snapshot!
    const identity = snapshot.windows.get(live.tmuxWindow)
    if (!identity) return
    let saved = identity.boardId
      ? this.catalog.get(identity.boardId)
      : this.catalog.byWindow(live.tmuxWindow, snapshot.epoch)
    const record = live.agentSessionId
      ? this.db.getSessionById(live.agentSessionId)
      : this.db.getSessionByWindow(live.tmuxWindow)
    if (!saved && record) saved = this.catalog.byProvider(record.sessionId)
    if (!saved)
      saved = this.catalog.create({
        name: live.name,
        projectPath: live.projectPath,
        command: live.command || '',
        agentType: live.agentType ?? null,
        origin: 'discovered',
      })
    // Adopt live windows only for states that expect a process. A
    // hibernating/archived row whose tagged window somehow survived must not
    // be resurrected by passive observation — that would undo a user stop.
    if (saved.state === 'interrupted' || saved.state === 'failed') {
      const run = this.catalog.beginRun(saved.id)
      this.tagWindow(live.tmuxWindow, saved.id, run.id)
      this.catalog.bind(
        saved.id,
        run.id,
        live.tmuxWindow,
        snapshot.epoch
      )
      // Re-adoption: an interruption released the conversation's claim on
      // this window; take it back now that the row runs here again.
      if (!record) this.reclaimProvider(saved.id, live.tmuxWindow)
    }
    if (record)
      this.catalog.associate(
        saved.id,
        record.sessionId,
        record.agentType,
        record.lastUserMessage
      )
    if (identity.provisional && saved.lastRunId) {
      this.tagWindow(live.tmuxWindow, saved.id, saved.lastRunId)
    }
    if (saved.name !== live.name) {
      try {
        this.manager.renameWindow(live.tmuxWindow, saved.name)
      } catch {
        // tmux refused (e.g. a name collision) — follow reality instead of
        // throwing on every refresh.
        this.catalog.rename(saved.id, live.name)
      }
    }
    if (
      saved.lastActivityAt !== live.lastActivity ||
      saved.preview !== live.lastUserMessage
    )
      this.catalog.updateActivity(
        saved.id,
        live.lastActivity,
        live.lastUserMessage
      )
    live.boardSessionId = saved.id
  }
  launch(
    projectPath: string,
    name?: string,
    command?: string,
    options: {
      excludeSessionId?: string
      boardId?: string
      operationId?: string
    } = {}
  ) {
    this.manager.ensureSession()
    const identity = this.identity()
    let saved = options.boardId ? this.catalog.get(options.boardId) : null
    if (options.operationId && !options.boardId)
      saved = this.catalog.byOperation(options.operationId)
    if (!saved && options.excludeSessionId) {
      const record = this.db.getSessionById(options.excludeSessionId)
      if (record)
        saved = importConversation(this.catalog, record, this.isManagedWindow)
    }
    if (!saved)
      saved = this.catalog.create({
        name: name?.trim().replace(/\s+/g, '-') || generateSessionName(),
        projectPath,
        command: command || 'claude',
        agentType: inferAgentType(command || 'claude') ?? null,
      })
    const run = this.catalog.beginRun(saved.id, options.operationId)
    if (run.reused) {
      const current = this.catalog.get(saved.id)!
      const live =
        current.lastRunId === run.id ? this.findLive(current, identity) : null
      if (live) return live
      throw new RequestError(
        'This launch request already exists; refresh its saved status before retrying',
        409
      )
    }
    try {
      const live = this.manager.createWindow(
        projectPath,
        name || saved.name,
        command || saved.command || 'claude',
        {
          excludeSessionId: options.excludeSessionId,
          boardSessionId: saved.id,
          runId: run.id,
        }
      )
      this.catalog.bind(
        saved.id,
        run.id,
        live.tmuxWindow,
        identity.epoch,
        live.name
      )
      return { ...live, boardSessionId: saved.id }
    } catch (error) {
      // A pane may exist even if the acknowledgment failed. Leave its run open
      // for recovery to adopt, and never launch another process in this catch.
      // Bind against the fresh read's epoch — the pre-launch snapshot may be
      // from a previous server incarnation.
      try {
        const fresh = this.identity()
        const live = [...fresh.windows].find(
          ([, tag]) => tag.runId === run.id && tag.boardId === saved.id
        )
        if (live)
          this.catalog.bind(saved.id, run.id, live[0], fresh.epoch, saved.name)
        else this.catalog.transition(saved.id, 'failed', String(error))
      } catch {
        /* Durable starting intent remains recoverable. */
      }
      throw error
    }
  }
  renameWindow(window: string, name: string) {
    const saved = this.catalog.byWindow(window)
    // Catalog validation first so both rules agree before anything mutates,
    // then tmux before the catalog write: a refused rename must not leave a
    // name the window does not have (observe() would fight tmux forever).
    if (saved) assertSessionName(name)
    this.manager.renameWindow(window, name)
    if (saved) this.catalog.rename(saved.id, name)
    if (saved?.providerId)
      this.db.updateSession(saved.providerId, { displayName: name.trim() })
  }
  private tagWindow(window: string, boardId: string, runId: string) {
    this.manager.setWindowOption(window, '@agentboard-session-id', boardId)
    this.manager.setWindowOption(window, '@agentboard-run-id', runId)
  }
  findLive(saved: SavedSession, identity?: TmuxIdentity): Session | null {
    if (
      !saved.lastRunId ||
      (saved.state !== 'running' && saved.state !== 'starting')
    )
      return null
    const snapshot = identity || this.identity()
    const match = [...snapshot.windows].find(
      ([, tag]) => tag.boardId === saved.id && tag.runId === saved.lastRunId
    )
    if (!match) return null
    const live = this.manager
      .listWindows()
      .find((s) => s.tmuxWindow === match[0])
    return live ? { ...live, boardSessionId: saved.id } : null
  }
  resume(
    id: string,
    commandFor: (record: AgentSessionRecord) => string,
    operationId?: string
  ): Session {
    const saved = this.catalog.get(id)
    if (!saved) throw notFound()
    const liveRun = this.findLive(saved)
    if (liveRun) return liveRun
    if (saved.state === 'starting')
      throw new RequestError('Session launch is still in progress; retry shortly', 409)
    if (saved.state === 'running') {
      this.catalog.transition(
        id,
        'interrupted',
        'Previous process is no longer available'
      )
      this.releaseProvider(saved)
    }
    const record = saved.providerId
      ? this.db.getSessionById(saved.providerId)
      : null
    if (record?.currentWindow) {
      const current = record.currentWindow
      if (this.isManagedWindow(current)) {
        const tag = this.identity().windows.get(current)
        if (tag && tag.boardId !== saved.id)
          throw new RequestError(
            'Conversation already belongs to another live session',
            409
          )
      } else if (this.manager.probeWindow(current) !== 'absent') {
        // The managed identity snapshot cannot see other tmux sessions, so ask
        // tmux directly; anything short of a definite "gone" keeps the claim.
        throw new RequestError(
          `Conversation is still running in another tmux window (${current})`,
          409
        )
      }
      this.db.orphanSession(record.sessionId, { expectedWindow: current })
    }
    const live = this.launch(
      saved.projectPath,
      saved.name,
      record ? commandFor(record) : saved.command,
      {
        boardId: id,
        excludeSessionId: record?.sessionId,
        operationId,
      }
    )
    if (record) {
      const claimed = this.db.claimCurrentWindow(
        record.sessionId,
        live.tmuxWindow,
        { displayName: live.name, lastResumeError: null, wakeStartedAt: null }
      )
      if (
        !claimed &&
        this.db.getSessionById(record.sessionId)?.currentWindow !==
          live.tmuxWindow
      ) {
        this.stop(this.catalog.get(id)!, 'hibernating', false)
        throw new RequestError(
          'Conversation already belongs to another window; the new launch was stopped',
          409
        )
      }
      return {
        ...live,
        agentSessionId: record.sessionId,
        logFilePath: record.logFilePath,
      }
    }
    return live
  }
  /**
   * The catalog row that owns `window` in the current tmux server, or null.
   * A row from an earlier server incarnation (window ids are reused) or one
   * whose run tags definitely differ from the live window's does not own it
   * (empty tags are unknown, as in reconcile; see identityChanged): callers
   * then treat the window as untracked instead of retiring that row. A row
   * whose window is already gone still owns it, so stopping it retires the
   * row without a kill.
   */
  ownerOfWindow(window: string): SavedSession | null {
    const identity = this.identity()
    const saved = this.catalog.byWindow(window, identity.epoch)
    if (!saved) return null
    // Same rule as reconcile: only a definite, different tag disowns the
    // row. An untagged window (a tag write that never landed) is still owned
    // by the row bound to it in this tmux server; window ids are not reused
    // within one server.
    if (identityChanged(identity.windows.get(window), saved)) return null
    return saved
  }
  /**
   * Kill a window through the catalog when a row owns it, so the row is
   * retired instead of left running on a dead window; otherwise kill it
   * directly. The conversation claim is left to the caller.
   */
  killWindow(window: string, state: 'hibernating' | 'archived') {
    const owner = this.ownerOfWindow(window)
    if (owner) this.stop(owner, state, false)
    else this.manager.killWindow(window)
  }
  /**
   * Move a row whose window is already gone to `state`, unless something
   * else (a reconcile, a relaunch) has moved it on since `saved` was read.
   */
  retire(saved: SavedSession, state: 'hibernating' | 'archived') {
    const current = this.catalog.get(saved.id)
    if (
      !current ||
      current.lastRunId !== saved.lastRunId ||
      (current.state !== 'running' && current.state !== 'starting')
    )
      return
    this.catalog.transition(saved.id, state)
  }
  stop(
    saved: SavedSession,
    state: 'hibernating' | 'archived',
    releaseProvider = true
  ) {
    // Persist intent before terminating the exact tagged run.
    this.db.db.transaction(() => {
      this.catalog.event(saved.id, `${state}-requested`)
      this.db.db
        .query('UPDATE board_sessions SET requested_state=? WHERE id=?')
        .run(state, saved.id)
    })()
    try {
      if (saved.window) {
        const identity = this.identity()
        const tag = identity.windows.get(saved.window)
        const tagged = tag?.boardId === saved.id && tag.runId === saved.lastRunId
        // An untagged window (tag write never landed) bound to this row in
        // the current tmux server is still this row's window.
        const untaggedOwn =
          !!tag && identity.epoch === saved.epoch && !identityChanged(tag, saved)
        if (tagged || untaggedOwn) this.manager.killWindow(saved.window)
      }
    } catch (error) {
      // Disarm the request: a failed stop must not silently kill the session
      // on a later refresh.
      this.db.db
        .query('UPDATE board_sessions SET requested_state=NULL WHERE id=?')
        .run(saved.id)
      throw error
    }
    this.catalog.transition(saved.id, state)
    if (releaseProvider) this.releaseProvider(saved, state === 'hibernating')
  }
  /**
   * Re-point the conversation of a row running in `window` at that window
   * when nothing else claims it (see db.reclaimCurrentWindow).
   */
  private reclaimProvider(id: string, window: string) {
    const saved = this.catalog.get(id)
    if (!saved?.providerId || saved.state !== 'running' || saved.window !== window)
      return
    const record = this.db.reclaimCurrentWindow(saved.providerId, window)
    if (record)
      logger.info('catalog_provider_reclaimed', {
        boardSessionId: saved.id,
        sessionId: saved.providerId,
        tmuxWindow: window,
      })
  }
  /**
   * Release the conversation's window claim only while it still points at
   * this row's window. The log rematcher (or a racing wake) may have moved
   * the conversation to another live window; clearing that claim would
   * orphan a running conversation.
   */
  private releaseProvider(saved: SavedSession, hibernate = true) {
    if (!saved.providerId) return
    this.db.orphanSession(saved.providerId, {
      hibernate,
      expectedWindow: saved.window,
    })
  }
}

/**
 * True only when tmux definitely reports a different run on the window. An
 * empty tag is unknown, not changed: the enumeration can predate the tag
 * write (the refresh worker's snapshot can be minutes old when tmux is slow)
 * or come from a format that cannot read tags. Window ids are not reused
 * within one tmux server, and the epoch check above covers restarts.
 */
export function identityChanged(
  tag: WindowIdentity | undefined,
  saved: Pick<SavedSession, 'id' | 'lastRunId'>
): boolean {
  if (!tag?.boardId || !tag.runId) return false
  return tag.boardId !== saved.id || tag.runId !== saved.lastRunId
}
