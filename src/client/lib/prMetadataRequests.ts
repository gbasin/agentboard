/** Bound PR metadata HTTP use so optional chips cannot occupy the browser's connection pool. */
type Lane = 'info' | 'checks'
type Job = () => Promise<void>

export function createMetadataScheduler(timeoutMs = 20_000) {
  const queues: Record<Lane, Job[]> = { info: [], checks: [] }
  const active: Record<Lane, boolean> = { info: false, checks: false }
  function drain(lane: Lane) {
    if (active[lane]) return
    const job = queues[lane].shift()
    if (!job) return
    active[lane] = true
    void job().finally(() => { active[lane] = false; drain(lane) })
  }
  return function schedule<T>(lane: Lane, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      queues[lane].push(async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try { resolve(await run(controller.signal)) } catch (error) { reject(error) }
        finally { clearTimeout(timer) }
      })
      drain(lane)
    })
  }
}

export const schedulePrMetadata = createMetadataScheduler()

/** Dedupe queued and running URLs, including callers that mount after dispatch. */
export function createInfoBatcher<T>(request: (urls: string[]) => Promise<T[]>, key: (item: T) => string) {
  const inflight = new Map<string, Promise<T | undefined>>()
  const pending = new Map<string, { resolve: (item: T | undefined) => void; reject: (error: unknown) => void }>()
  let scheduled = false
  function flush() {
    scheduled = false
    const entries = [...pending.entries()]
    pending.clear()
    for (let i = 0; i < entries.length; i += 8) {
      const batch = entries.slice(i, i + 8)
      void request(batch.map(([url]) => url)).then(items => {
        const byUrl = new Map(items.map(item => [key(item), item]))
        for (const [url, waiter] of batch) { inflight.delete(url); waiter.resolve(byUrl.get(url)) }
      }, error => {
        for (const [url, waiter] of batch) { inflight.delete(url); waiter.reject(error) }
      })
    }
  }
  return (url: string): Promise<T | undefined> => {
    const existing = inflight.get(url)
    if (existing) return existing
    const promise = new Promise<T | undefined>((resolve, reject) => pending.set(url, { resolve, reject }))
    inflight.set(url, promise)
    if (!scheduled) { scheduled = true; queueMicrotask(flush) }
    return promise
  }
}
