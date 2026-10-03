/** Persistence maintenance, health and policy. */
import type { SessionDatabase } from '../db'
import type { PersistenceHealth } from '../../shared/persistence'
import type { PersistentSessions } from './manager'
import { getPersistenceSettings } from './settings'
import { readTmuxIdentity } from './tmuxIdentity'
import { config } from '../config'

export class PersistenceRuntime {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private previewCursor = 0
  matchingFailure: () => string | null = () => null
  constructor(
    readonly sessions: PersistentSessions,
    readonly db: SessionDatabase
  ) {}
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
      error: this.sessions.error,
      matchingAvailable: Boolean(Bun.which('rg')),
      matchingError: this.matchingFailure(),
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
    } catch (error) {
      this.sessions.error = String(error)
    } finally {
      this.busy = false
    }
  }
}
