// slowOpLog.ts — Shared slow-operation logger.
//
// Same suppression scheme for every "X took too long on the event loop"
// signal: first slow call per key warns immediately; repeats are counted and
// reported as one aggregate line per key at most every window; an outlier
// bypasses suppression so the line lands next to the event_loop_lag it
// caused. The logger writes are themselves sync I/O on the main thread —
// under chronic slowness, one warn per call would be thousands of lines an
// hour during the very stall being diagnosed.
//
// `insideReport` guards against recursion: logging a slow fs call performs a
// sync fs write (pino transport), which the fs instrumentation also wraps.
// Without the guard a slow log write would log itself forever.

import { logger } from './logger'

interface SlowOpWindow {
  windowStart: number
  count: number
  maxMs: number
  sumMs: number
}

const slowWindows = new Map<string, SlowOpWindow>()
let insideReport = false

export function resetSlowOpState(): void {
  slowWindows.clear()
}

export interface SlowOpContext {
  /** Blocking only matters on the main thread; worker slowness is debug. */
  isMainThread?: boolean
  /** Monotonic ms clock; injectable for tests. */
  now?: number
}

export function logSlowOp(opts: {
  /** Log event name; `${event}_aggregate` is the window rollup. */
  event: string
  /** Suppression key — one warn/aggregate stream per distinct op. */
  key: string
  durationMs: number
  thresholdMs: number
  outlierMs: number
  aggregateMs: number
  /** Extra fields merged into warn and aggregate payloads. */
  fields?: Record<string, unknown>
  context?: SlowOpContext
}): void {
  const {
    event,
    key,
    durationMs,
    thresholdMs,
    outlierMs,
    aggregateMs,
    fields = {},
    context = {},
  } = opts
  if (durationMs < thresholdMs || insideReport) return
  const { isMainThread = Bun.isMainThread, now = performance.now() } = context
  if (!isMainThread) {
    insideReport = true
    try {
      logger.debug(event, { ...fields, durationMs, worker: true })
    } finally {
      insideReport = false
    }
    return
  }

  const windowKey = `${event}${key}`
  const window = slowWindows.get(windowKey)
  if (
    !window ||
    (window.count === 0 && now - window.windowStart >= aggregateMs)
  ) {
    insideReport = true
    try {
      logger.warn(event, { ...fields, durationMs })
    } finally {
      insideReport = false
    }
    slowWindows.set(windowKey, { windowStart: now, count: 0, maxMs: 0, sumMs: 0 })
    return
  }

  window.count += 1
  window.maxMs = Math.max(window.maxMs, durationMs)
  window.sumMs += durationMs
  insideReport = true
  try {
    if (durationMs >= outlierMs) {
      logger.warn(event, { ...fields, durationMs, outlier: true })
    }
    const windowMs = now - window.windowStart
    if (windowMs >= aggregateMs) {
      logger.warn(`${event}_aggregate`, {
        ...fields,
        count: window.count,
        maxMs: window.maxMs,
        sumMs: window.sumMs,
        windowMs: Math.round(windowMs),
      })
      slowWindows.set(windowKey, {
        windowStart: now,
        count: 0,
        maxMs: 0,
        sumMs: 0,
      })
    }
  } finally {
    insideReport = false
  }
}
