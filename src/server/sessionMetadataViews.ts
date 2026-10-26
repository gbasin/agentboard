/** Batch descriptors onto current views without replaying captured lifecycle state. */
import type { AgentSessionRecord } from './db'
import type { AgentSession } from '../shared/types'
import type { SessionRegistry } from './SessionRegistry'
import type { SessionMetadata } from './sessionMetadataWorker'
import { metadataIdentity } from './sessionMetadataClient'
import { logger } from './logger'

function publishBatch(registry: SessionRegistry, updates: Map<string, SessionMetadata>, host: string) {
  for (const session of registry.getAll()) {
    if (session.remote || !session.agentSessionId || !session.logFilePath || !session.agentType) continue
    const identity = metadataIdentity({ sessionId: session.agentSessionId, logFilePath: session.logFilePath, agentType: session.agentType })
    const update = updates.get(identity)
    if (update) registry.updateSession(session.id, update)
  }
  const current = registry.getAgentSessions()
  const patch = (rows: AgentSession[]) => rows.map(row => {
    const update = row.host === host ? updates.get(metadataIdentity(row)) : undefined
    return update ? { ...row, ...update } : row
  })
  // One equality check and at most one full historical-catalog event per batch.
  registry.setAgentSessions(patch(current.active), patch(current.hibernating), patch(current.history))
}

export function publishSessionMetadata(registry: SessionRegistry, record: AgentSessionRecord, metadata: SessionMetadata, host: string) {
  publishBatch(registry, new Map([[metadataIdentity(record), metadata]]), host)
}

/** Globally bound hydration publications; per-session timers still produce catalog storms. */
export class SessionMetadataPublisher {
  private pending = new Map<string, SessionMetadata>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly registry: SessionRegistry, private readonly host: string) {}

  queue(record: AgentSessionRecord, metadata: SessionMetadata): void {
    if (this.stopped) return
    const identity = metadataIdentity(record)
    // Keep the latest value per association, with bounded retained work.
    this.pending.delete(identity)
    this.pending.set(identity, metadata)
    if (this.pending.size > 5000) this.pending.delete(this.pending.keys().next().value!)
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.stopped) return
      const updates = this.pending
      this.pending = new Map()
      try { publishBatch(this.registry, updates, this.host) }
      catch (error) { logger.warn('session_metadata_batch_failed', { message: String(error) }) }
    }, 250)
    this.timer.unref?.()
  }

  dispose(): void {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
