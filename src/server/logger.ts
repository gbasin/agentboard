// Structured logger using pino
// Configure via env vars:
//   LOG_LEVEL: debug | info | warn | error (default: info)
//   LOG_FILE: path to log file (optional, enables file logging)

import { createRequire } from 'node:module'
import path from 'node:path'
import pino from 'pino'
import { config } from './config'

// Override pino/thread-stream worker path resolution for compiled Bun binaries.
// Without this, compiled binaries resolve worker paths relative to the CI build
// environment (/Users/runner/work/...) which doesn't exist on the user's machine.
// Worse: if the user runs the binary from a directory with node_modules (e.g. a
// project checkout), Bun leaks cwd module resolution into the bundled code,
// causing pino to spawn transport workers that crash and segfault the process —
// even when NODE_ENV=production should skip transports entirely.
try {
  const _require = createRequire(import.meta.url)
  ;(globalThis as Record<string, unknown>).__bundlerPathsOverrides = {
    'thread-stream-worker': _require.resolve('thread-stream/lib/worker.js'),
    'pino-worker': _require.resolve('pino/lib/worker.js'),
    'pino/file': _require.resolve('pino/file'),
    'pino-pretty': _require.resolve('pino-pretty'),
  }
} catch {
  // Resolution failed (compiled binary without node_modules on disk).
  // createLogger() falls back to sync destinations below.
}

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

function createLogger(): pino.Logger {
  const logLevel = getLogLevel()
  const logFile = getLogFile()
  const isDev = process.env.NODE_ENV !== 'production'

  // Dev mode: use pino-pretty for console, optionally also log to file
  // Wrapped in try-catch because compiled Bun binaries can't use pino transports
  // (they spawn worker_threads that dynamically require modules)
  if (isDev) {
    try {
      const targets: pino.TransportTargetOptions[] = [
        {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
          level: logLevel,
        },
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
      // Fall through to production logger (compiled binary or missing pino-pretty)
    }
  }

  // Production: use sync destinations for reliable flushing
  if (logFile) {
    fileDestination = pino.destination({ dest: logFile, sync: true, mkdir: true })
    const streams: pino.StreamEntry[] = [
      { level: logLevel, stream: pino.destination({ dest: 1, sync: true }) },
      { level: logLevel, stream: fileDestination },
    ]
    return pino({ level: logLevel }, pino.multistream(streams))
  }

  // Production without file: simple stdout
  return pino({ level: logLevel })
}

const pinoLogger: pino.Logger = createLogger()

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
