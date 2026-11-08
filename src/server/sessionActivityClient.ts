// Refresh never waits for activity I/O. Coalesce scans and fence publications by
// the latest association so old workers cannot resurrect removed/rebound panes.
import type { Session } from '../shared/types'
import type { SessionActivity } from '../shared/activity'
import type { CodexSubagentLink } from './logMatchWorkerTypes'
import { activityKey, supportsActivity, type ActivitySession, type ActivityPatch, type ActivityRequest, type ActivityResponse } from './sessionActivityProtocol'
import { sanitizedTmuxEnv } from './tmuxEnv'
import { resolveWorkerPath } from './workerPath'
import { logger } from './logger'

export class SessionActivityClient {
  private worker: Worker | null = null
  private stopped = false
  private current: number | null = null
  private serial = 0
  private pending: ActivitySession[] | null = null
  private active = new Set<string>()
  private cache = new Map<string, SessionActivity>()
  private links: CodexSubagentLink[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryAt = 0

  constructor(
    private readonly changed: (patches: ActivityPatch[]) => void,
    private readonly createWorker = (url: string) => new Worker(url, { type: 'module', env: sanitizedTmuxEnv() }),
    private readonly timeoutMs = 10_000,
    private readonly now = Date.now,
  ) {}

  enrich(sessions: Session[]): Session[] {
    if (this.stopped) return sessions
    this.pending = sessions.filter(s => !s.remote && supportsActivity(s)).map(s => ({
      id: s.id, source: s.source, agentType: s.agentType, logFilePath: s.logFilePath,
      agentSessionId: s.agentSessionId, boardSessionId: s.boardSessionId, agentboardTags: s.agentboardTags,
    }))
    this.active = new Set(this.pending.map(activityKey))
    for (const key of this.cache.keys()) if (!this.active.has(key)) this.cache.delete(key)
    this.pump()
    return sessions.map(s => this.active.has(activityKey(s)) ? { ...s, activity: this.cache.get(activityKey(s)) } : s)
  }

  setIndex(links: CodexSubagentLink[]): void {
    if (this.stopped) return
    this.links = links
    try { this.worker?.postMessage({ kind: 'index', links } satisfies ActivityRequest) }
    catch { this.failed('Activity index delivery failed') }
  }

  dispose(): void {
    this.stopped = true
    this.pending = null
    this.active.clear()
    this.cache.clear()
    this.retire()
  }

  private pump(): void {
    if (this.stopped || this.current !== null || this.pending === null || this.now() < this.retryAt) return
    const sessions = this.pending
    this.pending = null
    if (!sessions.length) return
    this.current = ++this.serial
    try {
      if (!this.worker) this.spawn()
      this.armTimer()
      this.worker!.postMessage({ kind: 'scan', id: this.current, sessions } satisfies ActivityRequest)
    } catch { this.failed('Activity scan delivery failed') }
  }

  private spawn(): void {
    const worker = this.createWorker(resolveWorkerPath('sessionActivityWorker'))
    this.worker = worker
    worker.onmessage = (event: MessageEvent<ActivityResponse>) => {
      if (this.stopped || this.worker !== worker || event.data.id !== this.current) return
      if ('progress' in event.data) { this.armTimer(); return }
      if ('error' in event.data) { this.failed(event.data.error); return }
      this.clearTimer()
      this.current = null
      const patches = event.data.patches.filter(patch => this.active.has(patch.key))
      const changed: ActivityPatch[] = []
      for (const patch of patches) {
        if (JSON.stringify(this.cache.get(patch.key)) !== JSON.stringify(patch.activity)) changed.push(patch)
        if (patch.activity) this.cache.set(patch.key, patch.activity)
        else this.cache.delete(patch.key)
      }
      if (changed.length) this.publish(changed)
      this.pump()
    }
    worker.onerror = () => { if (this.worker === worker) this.failed('Activity worker failed') }
    worker.onmessageerror = () => { if (this.worker === worker) this.failed('Activity worker message error') }
    worker.postMessage({ kind: 'index', links: this.links } satisfies ActivityRequest)
  }

  private failed(message: string): void {
    const patches = [...this.cache.keys()].map(key => ({ key, activity: undefined }))
    this.cache.clear()
    this.retire()
    this.retryAt = this.now() + 1000
    logger.warn('session_activity_worker_failed', { message })
    if (patches.length) this.publish(patches)
  }

  private publish(patches: ActivityPatch[]): void {
    try { this.changed(patches) }
    catch { logger.warn('session_activity_publish_failed') }
  }

  private armTimer(): void {
    this.clearTimer()
    this.timer = setTimeout(() => this.failed('Activity scan timed out'), this.timeoutMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private retire(): void {
    this.clearTimer()
    this.current = null
    const worker = this.worker
    this.worker = null
    if (worker) {
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
  }
}
