/** Durable discovery queue. Metadata ingestion does not depend on tmux or ripgrep. */
import fs from 'node:fs'
import type { SessionDatabase } from '../db'
import {
  scanAllLogDirs,
  getLogTimes,
  isCodexSubagent,
  isCodexExec,
  extractSessionId,
  extractProjectPath,
  extractSlug,
  inferAgentTypeFromPath,
} from '../logDiscovery'
import {
  extractLastEntryTimestamp,
  extractLastUserMessageFromLog,
} from '../logMatcher'
import { importConversations } from './legacyImport'
import type { SessionCatalog } from './catalog'

export class ConversationIndexer {
  private busy = false
  private lastScan = 0
  error: string | null = null
  constructor(
    private db: SessionDatabase,
    private catalog: SessionCatalog,
    private scan = scanAllLogDirs
  ) {}
  enqueue(paths: string[]) {
    const insert = this.db.db
      .query(`INSERT INTO conversation_index_queue(path,size,mtime) VALUES(?,?,?)
      ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,pending=1,retry_at=0
      WHERE size!=excluded.size OR mtime!=excluded.mtime`)
    this.db.db.transaction(() => {
      for (const file of paths) {
        if (!file.endsWith('.jsonl') || file.includes('/subagents/')) continue
        const times = getLogTimes(file)
        if (times) insert.run(file, times.size, times.mtime.getTime())
      }
    })()
  }
  get pending() {
    return (
      this.db.db
        .query(
          'SELECT count(*) AS n FROM conversation_index_queue WHERE pending=1'
        )
        .get() as { n: number }
    ).n
  }
  async tick(forceScan = false) {
    if (this.busy) return
    this.busy = true
    try {
      if (forceScan || Date.now() - this.lastScan > 60000) {
        this.enqueue(this.scan())
        this.lastScan = Date.now()
      }
      const batch = this.db.db
        .query(
          'SELECT path,size,mtime FROM conversation_index_queue WHERE pending=1 AND retry_at<=? ORDER BY mtime,path LIMIT 25'
        )
        .all(Date.now()) as { path: string; size: number; mtime: number }[]
      for (const entry of batch) {
        try {
          this.index(entry.path)
          // A concurrent notification with a new size remains queued.
          this.db.db
            .query(
              'UPDATE conversation_index_queue SET pending=0,error=NULL WHERE path=? AND size=? AND mtime=?'
            )
            .run(entry.path, entry.size, entry.mtime)
        } catch (error) {
          this.error = String(error)
          this.db.db
            .query(
              'UPDATE conversation_index_queue SET error=?,retry_at=? WHERE path=?'
            )
            .run(this.error, Date.now() + 60000, entry.path)
        }
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      importConversations(this.catalog, this.db)
      const failed = this.db.db
        .query(
          'SELECT error FROM conversation_index_queue WHERE pending=1 AND error IS NOT NULL LIMIT 1'
        )
        .get() as { error: string } | null
      this.error = failed?.error || null
    } catch (error) {
      this.error = String(error)
    } finally {
      this.busy = false
    }
  }
  private index(file: string) {
    if (!fs.existsSync(file)) return
    if (isCodexSubagent(file) || isCodexExec(file)) return
    const sessionId = extractSessionId(file),
      agentType = inferAgentTypeFromPath(file),
      times = getLogTimes(file)
    if (!sessionId || !agentType || !times)
      throw new Error(`Waiting for valid conversation metadata: ${file}`)
    const projectPath = extractProjectPath(file) || ''
    const preview = extractLastUserMessageFromLog(file, {
      byteLimit: 32768,
      maxByteLimit: 2 * 1024 * 1024,
    })
    const activity =
      extractLastEntryTimestamp(file) || times.mtime.toISOString()
    const existing = this.db.getSessionById(sessionId)
    if (existing) {
      this.db.updateSession(sessionId, {
        // The terminal matcher owns lastKnownLogSize. Updating its watermark
        // here would make an unmatched, newly indexed conversation look handled.
        logFilePath: file,
        lastActivityAt: activity,
        ...(preview ? { lastUserMessage: preview } : {}),
      })
      const saved = this.catalog.byProvider(sessionId)
      if (saved?.providerId === sessionId)
        this.catalog.updateActivity(saved.id, activity, preview || undefined)
      return
    }
    this.db.insertSession({
      sessionId,
      logFilePath: file,
      projectPath,
      slug: extractSlug(file),
      agentType,
      displayName: projectPath.split('/').at(-1) || sessionId.slice(0, 8),
      createdAt: times.birthtime.toISOString(),
      lastActivityAt: activity,
      lastUserMessage: preview,
      currentWindow: null,
      isHibernating: false,
      lastResumeError: null,
      lastKnownLogSize: null,
      isCodexExec: false,
      launchCommand: null,
    })
  }
}
