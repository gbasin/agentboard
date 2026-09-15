/** Persistence maintenance, health, database ownership and policy. */
import type { SessionDatabase } from '../db'
import type { PersistenceHealth } from '../../shared/persistence'
import type { PersistentSessions } from './manager'
import { ConversationIndexer } from './indexer'
import { SessionBackups } from './backups'
import { ConversationArchives } from './archives'
import { getPersistenceSettings } from './settings'
import { readTmuxIdentity } from './tmuxIdentity'
import { config } from '../config'

export class PersistenceRuntime {
  readonly indexer: ConversationIndexer
  readonly backups: SessionBackups | null
  readonly archives: ConversationArchives | null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private archiveCursor = ''
  private previewCursor = 0
  private archiveErrors = new Map<string, string>()
  matchingFailure: () => string | null = () => null
  constructor(
    readonly sessions: PersistentSessions,
    readonly db: SessionDatabase
  ) {
    this.indexer = new ConversationIndexer(db, sessions.catalog)
    const file = (db.db.query('PRAGMA database_list').get() as { file: string })
      .file
    this.backups = file ? new SessionBackups(db.db, file) : null
    this.archives = file ? new ConversationArchives(db, file) : null
  }
  start() {
    if (this.timer) return
    const interval = Number(
      process.env.AGENTBOARD_PERSISTENCE_MAINTENANCE_MS ?? 5000
    )
    if (!Number.isFinite(interval) || interval <= 0) return
    this.timer = setInterval(
      () => {
        void this.tick()
      },
      Math.max(1000, interval)
    )
    this.timer.unref?.()
    void this.tick()
  }
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  health(): PersistenceHealth {
    return {
      lastSavedAt: this.db.getAppSetting('persistence_last_saved'),
      pendingIndex: this.indexer.pending,
      indexError: this.indexer.error || this.sessions.error,
      matchingAvailable: Boolean(Bun.which('rg')),
      matchingError: this.matchingFailure(),
      lastBackupAt: this.backups?.list()[0]?.createdAt || null,
      backupError: this.backups?.error || null,
      archiveBytes: this.archives?.bytes || 0,
      archiveError: this.archives?.error || null,
      interrupted: (
        this.db.db
          .query(
            "SELECT count(*) AS n FROM board_sessions WHERE state IN ('interrupted','failed')"
          )
          .get() as { n: number }
      ).n,
      settings: getPersistenceSettings(this.db),
    }
  }
  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      await this.indexer.tick()
      const settings = getPersistenceSettings(this.db)
      if (settings.capturePreviews) {
        try {
          const active = this.sessions.catalog.active()
          if (this.previewCursor >= active.length) this.previewCursor = 0
          const identity = readTmuxIdentity(config.tmuxSession)
          for (const saved of active.slice(
            this.previewCursor,
            this.previewCursor + 10
          )) {
            if (!saved.window) continue
            const tag = identity.windows.get(saved.window)
            if (
              saved.epoch !== identity.epoch ||
              tag?.boardId !== saved.id ||
              tag.runId !== saved.lastRunId
            )
              continue
            const captured = Bun.spawnSync(
              ['tmux', 'capture-pane', '-p', '-t', saved.window, '-S', '-80'],
              { stdout: 'pipe', stderr: 'pipe', timeout: 1000 }
            )
            if (captured.exitCode === 0)
              this.db.db
                .query(
                  'UPDATE board_sessions SET terminal_preview=?,terminal_preview_at=? WHERE id=?'
                )
                .run(
                  captured.stdout.toString().slice(-32768),
                  new Date().toISOString(),
                  saved.id
                )
          }
          this.previewCursor += 10
        } catch (error) {
          this.sessions.error = String(error)
        }
      }
      if (this.backups) {
        try {
          const latest = this.backups
            .list()
            .find((b) => b.name.includes('-automatic-'))
          if (!latest || Date.now() - Date.parse(latest.createdAt) > 3600000) {
            this.backups.create('automatic')
            this.backups.rotate(settings)
          }
        } catch (error) {
          this.backups.error = String(error)
        }
      }
      if (settings.archiveEnabled && this.archives) {
        const ids = this.db.db
          .query(
            `SELECT DISTINCT provider_id AS id FROM session_conversations WHERE provider_id>? ORDER BY provider_id LIMIT 5`
          )
          .all(this.archiveCursor) as { id: string }[]
        if (!ids.length) this.archiveCursor = ''
        for (const { id } of ids) {
          this.archiveCursor = id
          const record = this.db.getSessionById(id)
          if (record)
            try {
              await this.archives.archive(record, settings.archiveMaxBytes)
              this.archiveErrors.delete(id)
            } catch (error) {
              this.archiveErrors.set(id, String(error))
            }
        }
        this.archives.error = this.archiveErrors.values().next().value || null
      }
    } catch (error) {
      this.sessions.error = String(error)
    } finally {
      this.busy = false
    }
  }
}
