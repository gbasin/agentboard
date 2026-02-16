/** Fire-and-forget POST to /api/client-log. Swallows all errors. */
export function clientLog(event: string, data?: Record<string, unknown>) {
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data }),
    }).catch(() => {})
  } catch {
    // ignore
  }
}
