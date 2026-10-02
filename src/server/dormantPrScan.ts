import type { AgentSessionRecord } from './db'
import { getMergedPullRequests, needsPullRequestScan } from './agentSessions'

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
 * startup never reads every log synchronously. `onChanged` fires when new PRs
 * were found, at most about once per second plus once when the queue drains.
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

  const notify = () => {
    changed = false
    lastNotify = performance.now()
    onChanged()
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
      if (!needsPullRequestScan(record)) continue
      try {
        if (getMergedPullRequests(record).length > 0) changed = true
      } catch {
        // A bad log must not stop the rest of the queue.
      }
    }
    pending = pending.slice(index)
    const drained = pending.length === 0
    if (changed && (drained || performance.now() - lastNotify >= notifyMs)) {
      notify()
    }
    if (!drained && timer === null) {
      timer = setTimeout(tick, gapMs)
    }
  }

  return {
    queue(records) {
      pending = records.filter(needsPullRequestScan)
      if (pending.length > 0 && timer === null) {
        timer = setTimeout(tick, gapMs)
      }
    },
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    },
  }
}
