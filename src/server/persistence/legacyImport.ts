/** Enrich the stable catalog from provider records without replacing custom names. */
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { SessionCatalog } from './catalog'

export function importConversations(catalog: SessionCatalog, db: SessionDatabase) {
  const ids = db.db.query(`SELECT session_id AS id FROM agent_sessions a WHERE a.is_codex_exec=0 AND NOT EXISTS
    (SELECT 1 FROM board_sessions b WHERE b.provider_id=a.session_id) ORDER BY id LIMIT 100`).all() as {id:string}[]
  for (const {id} of ids) {
    const record = db.getSessionById(id)
    if (!record || record.isCodexExec) continue
    const live = record.currentWindow ? catalog.byWindow(record.currentWindow) : null
    if (live && !live.providerId) {
      catalog.associate(live.id,id,record.agentType,record.lastUserMessage)
      continue
    }
    importConversation(catalog,record)
  }
}
export function importConversation(catalog: SessionCatalog, record: AgentSessionRecord) {
  return catalog.byProvider(record.sessionId) || catalog.create({
    name:record.displayName,projectPath:record.projectPath,command:record.launchCommand || '',
    agentType:record.agentType,providerId:record.sessionId,createdAt:record.createdAt,
    lastActivityAt:record.lastActivityAt,preview:record.lastUserMessage,
    state:record.currentWindow ? 'interrupted' : record.isPinned ? 'hibernating' : 'archived',
    pinned:record.isPinned,origin:'imported',
  })
}
