import type { AgentSessionRecord } from './db'
import {
  needsPullRequestScan,
  pullRequestScanPlan,
  type PullRequestScanPlan,
  rescanPullRequests,
  warmPullRequestScan,
} from './agentSessions'
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
 *
 * A session's main log and each of its subagent logs are separate steps, so a
 * session with many large subagent logs spans several slices. Freshness is
 * checked in the slices too (it stats subagent logs), so `queue` stays cheap
 * and a re-queue after a new codex subagent index or a grown subagent log
 * rescans only the sessions whose logs changed.
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
  // Scan key this scanner last scanned per queued session. The shared PR
  // cache is capped and can evict entries; without this, an evicted session
  // would be rescanned (and reported as changed) on every re-queue.
  let scannedKeys = new Map<string, string>()
  // Next log to read for a session whose scan spans slices.
  let cursor: { sessionId: string; next: number } | null = null

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

  const overBudget = (start: number) => performance.now() - start >= budgetMs

  /** Scans one session; returns false when the slice ran out mid-session. */
  const scanRecord = (
    record: AgentSessionRecord,
    plan: PullRequestScanPlan,
    start: number
  ): boolean => {
    const { paths } = plan
    let next = cursor?.sessionId === record.sessionId ? cursor.next : 0
    cursor = null
    while (next < paths.length) {
      warmPullRequestScan(record, paths[next++])
      if (next < paths.length && overBudget(start)) {
        cursor = { sessionId: record.sessionId, next }
        return false
      }
    }
    // Every log is now in the extractor's cache; merging only stats them.
    if (rescanPullRequests(record, plan)) changed = true
    return true
  }

  const tick = () => {
    timer = null
    const start = performance.now()
    let index = 0
    // Always make progress: at least one record (or one log) per slice.
    while (index < pending.length && (index === 0 || !overBudget(start))) {
      const record = pending[index]
      let done = true
      try {
        // One subagent lookup per record per slice: the key and the paths
        // the scan reads come from the same listing.
        const plan = pullRequestScanPlan(record)
        if (
          needsPullRequestScan(record, plan.key) &&
          scannedKeys.get(record.sessionId) !== plan.key
        ) {
          done = scanRecord(record, plan, start)
          if (done) scannedKeys.set(record.sessionId, plan.key)
        }
      } catch {
        // A bad log must not stop the rest of the queue.
        cursor = null
      }
      if (!done) break
      index++
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
      scannedKeys = new Map(
        [...scannedKeys].filter(([sessionId]) => queuedIds.has(sessionId))
      )
      // Freshness is checked per slice, not here: it stats subagent logs.
      pending = records.slice()
      // The throttle window starts with each scan run, not at process start.
      if (idle) lastNotify = performance.now()
      schedule()
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
      changed = false
      scannedKeys.clear()
      cursor = null
    },
  }
}
