/**
 * clientLog.ts — Fire-and-forget client-side logging to the server.
 *
 * Each clientLog() call emits at a given level (default: 'debug').
 * The server advertises its LOG_LEVEL via server-config on WS connect,
 * and setClientLogLevel() updates the client-side threshold accordingly.
 * Calls below the threshold are skipped entirely (no fetch()).
 *
 * In practice: the server defaults to LOG_LEVEL=info, so all debug-level
 * profiling logs are zero-cost no-ops unless the server is explicitly
 * started with LOG_LEVEL=debug.
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
  const normalized = level.toLowerCase()
  if (normalized in LEVEL_PRIORITY) {
    serverLogLevel = normalized as LogLevel
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
