/** Reserve bounded scan capacity for a finite snapshot, even under constant activity. */
export class LogReconciliation {
  private roots = ''
  private pending: string[] = []
  private position = 0
  private singleRecent = true

  select<T extends { logPath: string }>(recent: T[], limit: number, roots: string): T[] {
    if (this.roots !== roots) {
      this.roots = roots
      this.pending = []
      this.position = 0
      this.singleRecent = true
    }
    if (this.position >= this.pending.length) {
      // Freeze membership until this sweep finishes. New files cannot push
      // older files back indefinitely by arriving ahead of a moving cursor.
      this.pending = recent.map((entry) => entry.logPath)
      this.position = 0
    }
    const byPath = new Map(recent.map((entry) => [entry.logPath, entry]))
    const selected = new Map<string, T>()
    const recentBudget = limit === 1
      ? (this.singleRecent ? 1 : 0)
      : Math.ceil(limit / 2)
    if (limit === 1) this.singleRecent = !this.singleRecent
    for (const entry of recent.slice(0, recentBudget)) {
      selected.set(entry.logPath, entry)
    }
    while (selected.size < limit && this.position < this.pending.length) {
      const entry = byPath.get(this.pending[this.position++]!)
      if (entry) selected.set(entry.logPath, entry)
    }
    // A finished sweep or deleted files may leave spare capacity.
    for (const entry of recent) {
      if (selected.size >= limit) break
      selected.set(entry.logPath, entry)
    }
    return [...selected.values()]
  }
}
