/** Enrich the stable catalog from provider records without replacing custom names. */
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { SessionCatalog } from './catalog'

/** True when `window` (`session:@id`) lives in the board's own tmux session. */
export type ManagedWindowTest = (window: string) => boolean

export function importConversations(
  catalog: SessionCatalog,
  db: SessionDatabase,
  isManagedWindow: ManagedWindowTest
) {
  const ids = db.db
    .query(
      `SELECT session_id AS id FROM agent_sessions a WHERE a.is_codex_exec=0 AND NOT EXISTS
    (SELECT 1 FROM session_conversations c WHERE c.provider_id=a.session_id) ORDER BY id LIMIT 100`
    )
    .all() as { id: string }[]
  for (const { id } of ids) {
    const record = db.getSessionById(id)
    if (!record || record.isCodexExec) continue
    const live = record.currentWindow
      ? catalog.byWindow(record.currentWindow)
      : null
    if (live && !live.providerId) {
      catalog.associate(live.id, id, record.agentType, record.lastUserMessage)
      continue
    }
    importConversation(catalog, record, isManagedWindow)
  }
}
/**
 * Only a window in the managed session can be reconciled by the catalog, so
 * only that case imports as `interrupted` (recoverable). A conversation hosted
 * in another tmux session is still running there: importing it as
 * interrupted would offer — and auto-resume — a second copy of it.
 */
export function importConversation(
  catalog: SessionCatalog,
  record: AgentSessionRecord,
  isManagedWindow: ManagedWindowTest
) {
  return (
    catalog.byProvider(record.sessionId) ||
    catalog.create({
      name: record.displayName,
      projectPath: record.projectPath,
      command: record.launchCommand || '',
      agentType: record.agentType,
      providerId: record.sessionId,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      preview: record.lastUserMessage,
      state: record.currentWindow
        ? isManagedWindow(record.currentWindow)
          ? 'interrupted'
          : 'archived'
        : record.isHibernating
          ? 'hibernating'
          : 'archived',
      pinned: false,
      origin: 'imported',
    })
  )
}
