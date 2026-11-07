/** Wire projections prevent detail collections from leaking through lifecycle paths. */
import type { AgentSession, ServerMessage, Session } from '../shared/types'

export function sessionSummary<T extends Session | AgentSession>(row: T): Omit<T, 'media'> {
  const { media: _detail, ...summary } = row
  // The sidebar displays a preview, never an entire user prompt.
  if (summary.lastUserMessage) summary.lastUserMessage = summary.lastUserMessage.slice(0, 250)
  return summary
}

export function catalogMessage(message: ServerMessage): ServerMessage {
  switch (message.type) {
    case 'sessions': return { ...message, sessions: message.sessions.map(sessionSummary) }
    case 'agent-sessions': return { ...message, active: message.active.map(sessionSummary),
      hibernating: message.hibernating.map(sessionSummary), history: message.history.map(sessionSummary) }
    case 'agent-sessions-active': return { ...message, active: message.active.map(sessionSummary) }
    case 'session-update': case 'session-created': case 'session-orphaned': case 'session-activated':
      return { ...message, session: sessionSummary(message.session) } as ServerMessage
    case 'session-wake-result': case 'session-hibernate-result': case 'session-move-to-history-result':
      return { ...message, ...(message.session ? { session: sessionSummary(message.session) } : {}) } as ServerMessage
    default: return message
  }
}
