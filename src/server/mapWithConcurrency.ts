/**
 * Map items through an async function with at most `limit` calls in flight.
 * Results keep input order, like Promise.all. The first rejection rejects the
 * returned promise, like Promise.all; calls already in flight keep running.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  const workerCount = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}
