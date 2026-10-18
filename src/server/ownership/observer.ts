// Observational rollout: this class only reads snapshots and emits diagnostics.
import type { Observation, OwnershipWindow } from './probe'

export class OwnershipObserver {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false
  private generation = 0
  private previous = new Map<string, string>()
  private lastError: string | null = null

  constructor(private readonly dependencies: {
    windows: () => OwnershipWindow[]
    probe: (windows: OwnershipWindow[]) => Promise<Observation[]>
    log: (event: string, data: Record<string, unknown>) => void
  }) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.observe() }, Math.max(5000, intervalMs))
    this.timer.unref?.()
    void this.observe()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.generation++
    this.previous.clear()
  }

  async observe(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    const generation = this.generation
    const started = performance.now()
    try {
      const windows = this.dependencies.windows().filter(window => !window.remote && ['codex', 'claude'].includes(window.agentType ?? ''))
        .map(window => ({ ...window, agentboardTags: window.agentboardTags ? { ...window.agentboardTags } : undefined }))
      const results = await this.dependencies.probe(windows)
      if (generation !== this.generation) return
      const current = this.dependencies.windows()
      const next = new Map<string, string>()
      const counts = { agree: 0, unmatched: 0, disagree: 0, unresolved: 0, discarded: 0 }
      for (const result of results) {
        const initial = windows.find(window => window.tmuxWindow === result.window)
        const live = current.find(window => !window.remote && window.tmuxWindow === result.window)
        if (!live || !initial || live.agentType !== initial.agentType || live.agentSessionId !== initial.agentSessionId
          || live.agentboardTags?.runId !== initial.agentboardTags?.runId || live.agentboardTags?.serverPid !== initial.agentboardTags?.serverPid) {
          counts.discarded++
          continue
        }
        const comparison = result.status === 'unresolved' ? 'unresolved'
          : !live.agentSessionId ? 'unmatched'
          : live.agentSessionId === result.sessionId ? 'agree' : 'disagree'
        counts[comparison]++
        const data = { ...result, comparison, existingSessionId: live.agentSessionId ?? null }
        const key = `${result.window}:${result.pane}`
        const fingerprint = JSON.stringify(data)
        next.set(key, fingerprint)
        if (this.previous.get(key) !== fingerprint) this.dependencies.log('ownership_observation', data)
      }
      this.previous = next
      this.lastError = null
      this.dependencies.log('ownership_observation_summary', { ...counts, durationMs: Math.round(performance.now() - started) })
    } catch (error) {
      if (generation !== this.generation) return
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastError) this.dependencies.log('ownership_observation_error', { message })
      this.lastError = message
    } finally { this.inFlight = false }
  }
}
