import type { AgentSessionRecord } from './db'
import { needsPullRequestScan, rescanPullRequests } from './agentSessions'
import { logger } from './logger'

const SLICE_BUDGET_MS = 25
const SLICE_GAP_MS = 10
const NOTIFY_INTERVAL_MS = 1000

export interface DormantPrScanner {
  /** Replace the pending work with these records and start scanning. */
  queue(records: AgentSessionRecord[]): void
  stop(): void
}

/**
 * Scans dormant (hibernating/history) session logs for PRs in short slices so
 * startup never reads every log synchronously. `onChanged` fires when a scan
 * changed a session's PR list, at most about once per `notifyMs` plus once
 * when the queue drains.
 */
export function createDormantPrScanner(
  onChanged: () => void,
  options: { budgetMs?: number; gapMs?: number; notifyMs?: number } = {}
): DormantPrScanner {
  const budgetMs = options.budgetMs ?? SLICE_BUDGET_MS
  const gapMs = options.gapMs ?? SLICE_GAP_MS
  const notifyMs = options.notifyMs ?? NOTIFY_INTERVAL_MS
  let pending: AgentSessionRecord[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let changed = false
  let lastNotify = 0
  // Log size this scanner last scanned per queued session. The shared PR
  // cache is capped and can evict entries; without this, an evicted session
  // would be rescanned (and reported as changed) on every re-queue.
  let scannedSizes = new Map<string, number | null>()

  const needsScan = (record: AgentSessionRecord) =>
    needsPullRequestScan(record) &&
    scannedSizes.get(record.sessionId) !== (record.lastKnownLogSize ?? null)

  const schedule = () => {
    if (pending.length > 0 && timer === null) {
      timer = setTimeout(tick, gapMs)
    }
  }

  const notify = () => {
    changed = false
    lastNotify = performance.now()
    try {
      onChanged()
    } catch (error) {
      logger.warn('dormant_pr_scan_notify_error', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const tick = () => {
    timer = null
    const start = performance.now()
    let index = 0
    // Always make progress: at least one record per slice.
    while (
      index < pending.length &&
      (index === 0 || performance.now() - start < budgetMs)
    ) {
      const record = pending[index++]
      if (!needsScan(record)) continue
      scannedSizes.set(record.sessionId, record.lastKnownLogSize ?? null)
      try {
        if (rescanPullRequests(record)) changed = true
      } catch {
        // A bad log must not stop the rest of the queue.
      }
    }
    pending = pending.slice(index)
    // Schedule before notifying so a throwing or re-queueing callback cannot
    // stall the remaining work.
    schedule()
    if (
      changed &&
      (pending.length === 0 || performance.now() - lastNotify >= notifyMs)
    ) {
      notify()
    }
  }

  return {
    queue(records) {
      const idle = pending.length === 0 && timer === null
      const queuedIds = new Set(records.map((record) => record.sessionId))
      scannedSizes = new Map(
        [...scannedSizes].filter(([sessionId]) => queuedIds.has(sessionId))
      )
      pending = records.filter(needsScan)
      // The throttle window starts with each scan run, not at process start.
      if (idle) lastNotify = performance.now()
      schedule()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
      changed = false
      scannedSizes.clear()
    },
  }
}
