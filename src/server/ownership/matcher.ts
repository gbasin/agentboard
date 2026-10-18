// Apply positive process evidence atomically. Inspection failures never release a claim.
import type { SessionDatabase } from '../db'
import type { Observation, OwnershipWindow } from './probe'

type Resolved = Extract<Observation, { status: 'resolved' }>
const incarnation = (window: OwnershipWindow) => JSON.stringify([
  window.agentType, window.agentboardTags?.runId, window.agentboardTags?.serverPid,
])

export class OwnershipMatcher {
  private evidence = new Map<string, { identity: string; previous?: string; result: Resolved }>()

  constructor(private readonly deps: {
    db: SessionDatabase
    windows: () => OwnershipWindow[]
    changed: (sessionId: string, window: string, previous: string | null) => void
    missing: (result: Resolved) => void
  }) {}

  /** A previous positive observation survives a temporary inspection outage. */
  get(window: OwnershipWindow): Resolved | undefined {
    const saved = this.evidence.get(window.tmuxWindow)
    if (window.remote || saved?.identity !== incarnation(window)) return undefined
    if (window.agentSessionId !== saved.previous && window.agentSessionId !== saved.result.sessionId) return undefined
    return saved.result
  }

  allows(window: string, sessionId: string): boolean {
    const live = this.deps.windows().find(item => item.tmuxWindow === window && !item.remote)
    const evidence = live && this.get(live)
    return !evidence || evidence.sessionId === sessionId
  }

  accept(result: Observation, window: OwnershipWindow): void {
    // Bound memory to currently visible windows, including removed external windows.
    const live = new Set(this.deps.windows().map(item => item.tmuxWindow))
    for (const key of this.evidence.keys()) if (!live.has(key)) this.evidence.delete(key)
    if (result.status !== 'resolved' || window.remote || result.agent !== window.agentType || result.window !== window.tmuxWindow) return
    const { db } = this.deps
    const current = db.getSessionByWindow(result.window)
    // Database mutations may precede the next registry refresh while probing.
    if ((current?.sessionId ?? null) !== (window.agentSessionId ?? null)) return
    this.evidence.set(result.window, { identity: incarnation(window), previous: window.agentSessionId, result })
    const target = db.getSessionById(result.sessionId)
    if (!target) { this.deps.missing(result); return }
    if (target.agentType !== result.agent || target.isCodexExec
      || (result.transcript && target.logFilePath !== result.transcript)
      || (target.currentWindow && target.currentWindow !== result.window)) return
    if (current?.sessionId === target.sessionId) return
    // Do not undo a requested stop/wake while its asynchronous lifecycle runs.
    if (target.isHibernating || target.wakeStartedAt || current?.isHibernating || current?.wakeStartedAt) return
    const changed = db.db.transaction(() => {
      if (current) db.orphanSession(current.sessionId, { hibernate: false })
      const claimed = db.claimCurrentWindow(target.sessionId, result.window, { lastResumeError: null })
      if (!claimed) throw new Error('ownership claim changed during transaction')
      return claimed
    })()
    if (changed) this.deps.changed(target.sessionId, result.window, current?.sessionId ?? null)
  }
}
