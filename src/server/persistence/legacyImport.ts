/** Enrich the stable catalog from provider records without replacing custom names. */
import type { SessionDatabase, AgentSessionRecord } from '../db'
import type { SessionCatalog } from './catalog'
import { readImportCandidates } from '../sessionReads'

/** True when `window` (`session:@id`) lives in the board's own tmux session. */
export type ManagedWindowTest = (window: string) => boolean

export function importConversations(
  catalog: SessionCatalog,
  db: SessionDatabase,
  isManagedWindow: ManagedWindowTest
) {
  importConversationIds(catalog, db, isManagedWindow, readImportCandidates(db.db))
}

/** Re-read current rows after an asynchronous scan before applying any writes. */
export function importConversationIds(
  catalog: SessionCatalog,
  db: SessionDatabase,
  isManagedWindow: ManagedWindowTest,
  ids: string[]
) {
  // One indexed batch fetch — the per-id getSessionById loop was an N+1
  // (up to 100 probes per reconcile) surfaced as sync_db_slow outliers.
  const records = new Map(
    db.getSessionsByIds(ids).map((record) => [
      record.sessionId,
      record,
    ])
  )
  for (const id of ids) {
    const record = records.get(id)
    if (!record || record.isCodexExec) continue
    const live = record.currentWindow
      ? catalog.byWindow(record.currentWindow)
      : null
    if (live && !live.providerId) {
      if (catalog.byProvider(id)) continue
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
