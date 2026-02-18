// Structured logger using pino
// Configure via env vars:
//   LOG_LEVEL: debug | info | warn | error (default: info)
//   LOG_FILE: path to log file (optional, enables file logging)

import path from 'node:path'
import pino from 'pino'
import { config } from './config'

type LogData = Record<string, unknown>
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Resolve log level from env or config, with fallback
// Env var takes precedence over config
function getLogLevel(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase() ?? config?.logLevel
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level
  }
  return 'info'
}

// Resolve log file from env or config, expanding ~ to home dir
// Env var takes precedence over config
function getLogFile(): string {
  const logFile = process.env.LOG_FILE ?? config?.logFile ?? ''
  if (logFile.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    return path.join(home, logFile.slice(2))
  }
  return logFile
}

// Track file destination for cleanup
let fileDestination: pino.DestinationStream | null = null

const PRETTY_OPTIONS = {
  colorize: true,
  translateTime: 'SYS:standard',
  ignore: 'pid,hostname',
}

function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty')
    return true
  } catch {
    /* logging-audit:intentional */
    return false
  }
}

function createLogger(): pino.Logger {
  const logLevel = getLogLevel()
  const logFile = getLogFile()
  const isDev = process.env.NODE_ENV !== 'production'
  const canPretty = hasPinoPretty()

  // Dev mode: use pino-pretty for console, optionally also log to file
  // Requires pino transports (worker_threads) — unavailable in compiled Bun binaries
  if (isDev && canPretty) {
    try {
      const targets: pino.TransportTargetOptions[] = [
        { target: 'pino-pretty', options: PRETTY_OPTIONS, level: logLevel },
      ]

      // Also log to file in dev if LOG_FILE is explicitly set via env var
      // (don't use config default in dev to avoid noisy file logging)
      if (process.env.LOG_FILE) {
        targets.push({
          target: 'pino/file',
          options: { destination: logFile, mkdir: true },
          level: logLevel,
        })
      }

      return pino({ level: logLevel, transport: { targets } })
    } catch {
      /* logging-audit:intentional */
      // Fall through to production logger (compiled binary or missing pino-pretty)
    }
  }

  // Production (or dev fallback): human-readable stdout, structured JSON file
  // Uses pino-pretty for stdout when available (npx installs), otherwise raw JSON
  // with ISO timestamps as fallback (compiled binaries)
  const baseOptions: pino.LoggerOptions = {
    level: logLevel,
    base: {},                              // strip pid, hostname
    timestamp: pino.stdTimeFunctions.isoTime, // ISO 8601 instead of epoch ms
  }

  if (logFile) {
    fileDestination = pino.destination({ dest: logFile, sync: true, mkdir: true })

    if (canPretty) {
      try {
        const prettyStdout = pino.transport({ target: 'pino-pretty', options: PRETTY_OPTIONS })
        const streams: pino.StreamEntry[] = [
          { level: logLevel, stream: prettyStdout },
          { level: logLevel, stream: fileDestination },
        ]
        return pino(baseOptions, pino.multistream(streams))
      } catch {
        /* logging-audit:intentional */
        /* fall through */
      }
    }

    const streams: pino.StreamEntry[] = [
      { level: logLevel, stream: pino.destination({ dest: 1, sync: true }) },
      { level: logLevel, stream: fileDestination },
    ]
    return pino(baseOptions, pino.multistream(streams))
  }

  // Without log file: pretty stdout or plain JSON
  if (canPretty) {
    try {
      return pino(baseOptions, pino.transport({ target: 'pino-pretty', options: PRETTY_OPTIONS }))
    } catch {
      /* logging-audit:intentional */
      /* fall through */
    }
  }
  return pino(baseOptions)
}

const pinoLogger: pino.Logger = createLogger()

/** Resolved log level — exposed so server-config can send it to the client. */
export const logLevel: LogLevel = getLogLevel()

// Flush pending logs
// Call before process.exit() to ensure logs are written
export function flushLogger(): void {
  pinoLogger.flush()
  if (fileDestination && 'flushSync' in fileDestination) {
    ;(fileDestination as pino.DestinationStream & { flushSync: () => void }).flushSync()
  }
}

// Close logger and release resources (for tests)
export function closeLogger(): void {
  flushLogger()
  if (fileDestination && 'end' in fileDestination) {
    ;(fileDestination as pino.DestinationStream & { end: () => void }).end()
  }
  fileDestination = null
}

// Wrapper to maintain existing API: logger.info('event_name', { data })
// Pino's native API is logger.info({ data }, 'message'), so we adapt
// Note: { ...data, event } ensures event field isn't overwritten by data
export const logger = {
  debug: (event: string, data?: LogData) => pinoLogger.debug({ ...data, event }),
  info: (event: string, data?: LogData) => pinoLogger.info({ ...data, event }),
  warn: (event: string, data?: LogData) => pinoLogger.warn({ ...data, event }),
  error: (event: string, data?: LogData) => pinoLogger.error({ ...data, event }),
}
