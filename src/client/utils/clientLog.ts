/**
 * clientLog.ts — Fire-and-forget client-side logging to the server.
 *
 * Gated by the server's log level (sent via server-config on WS connect).
 * Default level is 'debug', so logs are suppressed unless the server is
 * running at LOG_LEVEL=debug. Call setClientLogLevel() when server-config
 * arrives to update the threshold.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** Server's active log level — events below this are skipped entirely. */
let serverLogLevel: LogLevel = 'info'

/** Called when server-config arrives with the server's log level. */
export function setClientLogLevel(level: string) {
  if (level in LEVEL_PRIORITY) {
    serverLogLevel = level as LogLevel
  }
}

/** Fire-and-forget POST to /api/client-log. Skipped if level is below server threshold. */
export function clientLog(event: string, data?: Record<string, unknown>, level: LogLevel = 'debug') {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[serverLogLevel]) return
  try {
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, data, level }),
    }).catch(() => {})
  } catch {
    // ignore
  }
}
