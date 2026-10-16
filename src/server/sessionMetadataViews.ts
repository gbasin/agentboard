/** Apply descriptors to current views without replaying captured lifecycle state. */
import type { AgentSessionRecord } from './db'
import type { AgentSession } from '../shared/types'
import type { SessionRegistry } from './SessionRegistry'
import type { SessionMetadata } from './sessionMetadataWorker'
import { metadataIdentity } from './sessionMetadataClient'

export function publishSessionMetadata(
  registry: SessionRegistry,
  record: AgentSessionRecord,
  metadata: SessionMetadata,
  host: string,
) {
  const identity = metadataIdentity(record)
  for (const session of registry.getAll()) {
    if (!session.remote && session.agentSessionId === record.sessionId &&
        session.logFilePath === record.logFilePath && session.agentType === record.agentType) {
      registry.updateSession(session.id, metadata)
    }
  }
  const current = registry.getAgentSessions()
  const patch = (rows: AgentSession[]) => rows.map((row) =>
    row.host === host && metadataIdentity(row) === identity ? { ...row, ...metadata } : row)
  registry.setAgentSessions(patch(current.active), patch(current.hibernating), patch(current.history))
}
