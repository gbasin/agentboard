/** Coordinate durable launch intents with tmux, including crash reconciliation. */
import type { Session } from '../../shared/types'
import type { Lifecycle, SavedSession } from '../../shared/persistence'
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { SessionManager } from '../SessionManager'
import { inferAgentType } from '../agentDetection'
import { generateSessionName } from '../nameGenerator'
import { SessionCatalog } from './catalog'
import { importConversations, importConversation } from './legacyImport'
import { readTmuxIdentity, type TmuxIdentity } from './tmuxIdentity'
import { config } from '../config'

export class PersistentSessions {
  readonly catalog: SessionCatalog
  private snapshot: TmuxIdentity | null = null
  error: string | null = null
  constructor(readonly db: SessionDatabase, readonly manager: SessionManager, hostId: string,
    private readonly identity = () => readTmuxIdentity(config.tmuxSession)) {
    this.catalog = new SessionCatalog(db.db,hostId)
    importConversations(this.catalog,db)
  }
  /** Only reconcile absence after an independent, successful identity snapshot. */
  beforeSnapshot(sessions: Session[]) {
    try {
      const snapshot = this.identity()
      const observed = new Set(sessions.filter(s => !s.remote && s.source === 'managed').map(s => s.tmuxWindow))
      if (observed.size !== snapshot.windows.size || [...observed].some(w => !snapshot.windows.has(w))) { this.snapshot=null; return }
      this.snapshot = snapshot
      for (const saved of this.catalog.active()) {
        const run = [...snapshot.windows].find(([,v]) => v.boardId === saved.id && v.runId === saved.lastRunId)
        if (saved.requestedState) {
          if (run) {
            this.manager.killWindow(run[0])
            snapshot.windows.delete(run[0])
            const index=sessions.findIndex(s=>s.tmuxWindow===run[0])
            if(index>=0)sessions.splice(index,1)
          }
          this.catalog.transition(saved.id,saved.requestedState)
          if(saved.providerId)this.db.orphanSession(saved.providerId,{hibernate:saved.requestedState==='hibernating'})
          continue
        }
        if (run) {
          if (saved.state !== 'running' || saved.window !== run[0] || saved.epoch !== snapshot.epoch) this.catalog.bind(saved.id,saved.lastRunId!,run[0],snapshot.epoch)
          continue
        }
        if (saved.epoch !== snapshot.epoch || !saved.window || !snapshot.windows.has(saved.window)) {
          this.catalog.transition(saved.id,'interrupted','Process stopped unexpectedly')
          if (saved.providerId) this.db.orphanSession(saved.providerId)
        } else if (snapshot.windows.get(saved.window)?.runId !== saved.lastRunId) {
          this.catalog.transition(saved.id,'interrupted','Window identity changed')
          if (saved.providerId) this.db.orphanSession(saved.providerId)
        }
      }
      // Legacy associations from another tmux lifetime must not claim reused IDs.
      const previousEpoch = this.db.getAppSetting('persistence_tmux_epoch')
      if (previousEpoch && previousEpoch !== snapshot.epoch) {
        for (const record of this.db.getActiveSessions()) this.db.orphanSession(record.sessionId)
      }
      this.db.setAppSetting('persistence_tmux_epoch',snapshot.epoch)
      this.error = null
    } catch (error) { this.error = String(error); this.snapshot = null }
  }
  observe(sessions: Session[]) {
    if (!this.snapshot) return
    for (const live of sessions.filter(s => !s.remote && s.source === 'managed')) {
      const identity = this.snapshot.windows.get(live.tmuxWindow)
      if (!identity) continue
      let saved = identity.boardId ? this.catalog.get(identity.boardId) : this.catalog.byWindow(live.tmuxWindow,this.snapshot.epoch)
      const record = live.agentSessionId ? this.db.getSessionById(live.agentSessionId) : this.db.getSessionByWindow(live.tmuxWindow)
      if (!saved && record) saved = this.catalog.byProvider(record.sessionId)
      if (!saved) saved = this.catalog.create({name:live.name,projectPath:live.projectPath,command:live.command || '',agentType:live.agentType ?? null,origin:'discovered'})
      if (saved.state !== 'running' && saved.state !== 'starting') {
        const run = this.catalog.beginRun(saved.id)
        this.manager.setWindowOption(live.tmuxWindow,'@agentboard-session-id',saved.id)
        this.manager.setWindowOption(live.tmuxWindow,'@agentboard-run-id',run.id)
        this.catalog.bind(saved.id,run.id,live.tmuxWindow,this.snapshot.epoch)
      }
      if (record) this.catalog.associate(saved.id,record.sessionId,record.agentType,record.lastUserMessage)
      if (saved.name !== live.name) this.manager.renameWindow(live.tmuxWindow,saved.name)
      if (saved.lastActivityAt !== live.lastActivity || saved.preview !== live.lastUserMessage) this.catalog.updateActivity(saved.id,live.lastActivity,live.lastUserMessage)
      live.boardSessionId = saved.id
    }
    importConversations(this.catalog,this.db)
  }
  launch(projectPath: string, name?: string, command?: string, options: {excludeSessionId?:string;boardId?:string;operationId?:string} = {}) {
    this.manager.ensureSession()
    const identity = this.identity()
    let saved = options.boardId ? this.catalog.get(options.boardId) : null
    if (!saved && options.excludeSessionId) {
      const record = this.db.getSessionById(options.excludeSessionId)
      if (record) saved = importConversation(this.catalog,record)
    }
    if (!saved) saved = this.catalog.create({name:name?.trim().replace(/\s+/g,'-') || generateSessionName(),projectPath,command:command || 'claude',agentType:inferAgentType(command || 'claude') ?? null})
    const run = this.catalog.beginRun(saved.id,options.operationId)
    if (run.reused) {
      const current = this.catalog.get(saved.id)!
      const live = this.manager.listWindows().find(s => s.tmuxWindow === current.window && identity.windows.get(s.tmuxWindow)?.runId === run.id)
      if (live) return {...live,boardSessionId:saved.id}
      throw new Error('This launch request already exists; refresh its saved status before retrying')
    }
    try {
      const live = this.manager.createWindow(projectPath,name || saved.name,command || saved.command || 'claude',{
        excludeSessionId:options.excludeSessionId,boardSessionId:saved.id,runId:run.id,
      })
      this.catalog.bind(saved.id,run.id,live.tmuxWindow,identity.epoch,live.name)
      return {...live,boardSessionId:saved.id}
    } catch (error) {
      // A pane may exist even if the acknowledgment failed. Leave its run open
      // for recovery to adopt, and never launch another process in this catch.
      try {
        const live = [...this.identity().windows].find(([,tag]) => tag.runId === run.id && tag.boardId === saved.id)
        if (live) this.catalog.bind(saved.id,run.id,live[0],identity.epoch)
        else this.catalog.transition(saved.id,'failed',String(error))
      } catch { /* Durable starting intent remains recoverable. */ }
      throw error
    }
  }
  renameWindow(window: string, name: string) {
    const saved = this.catalog.byWindow(window)
    if (saved) this.catalog.rename(saved.id,name)
    this.manager.renameWindow(window,name)
    if (saved?.providerId) this.db.updateSession(saved.providerId,{displayName:name})
  }
  markWindow(window: string, state: Lifecycle) {
    const saved = this.catalog.byWindow(window)
    if (saved) this.catalog.transition(saved.id,state)
  }
  resume(id: string, commandFor: (record:AgentSessionRecord)=>string, operationId?: string): Session {
    const saved = this.catalog.get(id)
    if (!saved) throw new Error('Session not found')
    if (saved.state === 'running') {
      const identity = this.identity()
      const live = this.manager.listWindows().find(s => s.tmuxWindow === saved.window && identity.windows.get(s.tmuxWindow)?.runId === saved.lastRunId)
      if (live) return {...live,boardSessionId:id}
      this.catalog.transition(id,'interrupted','Previous process is no longer available')
      if (saved.providerId) this.db.orphanSession(saved.providerId)
    }
    const record = saved.providerId ? this.db.getSessionById(saved.providerId) : null
    if (record?.currentWindow) {
      const tag = this.identity().windows.get(record.currentWindow)
      if (tag && tag.boardId !== saved.id) throw new Error('Conversation already belongs to another live session')
      this.db.orphanSession(record.sessionId)
    }
    const live = this.launch(saved.projectPath,saved.name,record ? commandFor(record) : saved.command,{
      boardId:id,excludeSessionId:record?.sessionId,operationId,
    })
    if (record) {
      const claimed = this.db.claimCurrentWindow(record.sessionId,live.tmuxWindow,{displayName:live.name,lastResumeError:null,wakeStartedAt:null})
      if (!claimed && this.db.getSessionById(record.sessionId)?.currentWindow !== live.tmuxWindow) {
        this.stop(this.catalog.get(id)!, 'hibernating', false)
        throw new Error('Conversation already belongs to another window; the new launch was stopped')
      }
      return {...live,agentSessionId:record.sessionId,logFilePath:record.logFilePath}
    }
    return live
  }
  stop(saved: SavedSession, state: 'hibernating'|'archived', releaseProvider = true) {
    // Persist intent before terminating the exact tagged run.
    this.db.db.transaction(() => {
      this.catalog.event(saved.id,`${state}-requested`)
      this.db.db.query("UPDATE board_sessions SET requested_state=? WHERE id=?").run(state,saved.id)
    })()
    if (saved.window) {
      const tag = this.identity().windows.get(saved.window)
      if (tag?.boardId === saved.id && tag.runId === saved.lastRunId) this.manager.killWindow(saved.window)
    }
    this.catalog.transition(saved.id,state)
    if (releaseProvider && saved.providerId) this.db.orphanSession(saved.providerId,{hibernate:state==='hibernating'})
  }
}
