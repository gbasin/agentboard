// Timing instrumentation for synchronous fs and bun:sqlite calls.
//
// The stall watchdog's `sample` reports showed the blocked main thread
// dominated by pread() plus JIT'd JS — synchronous file/db reads and heavy
// JSON work — while spawnSync barely registered. None of the fs/sqlite call
// sites are instrumented, so a 2s+ stall still can't name its cause. The
// whole codebase reaches sync fs through `import fs from 'node:fs'` and
// sqlite through `new Database()`, so wrapping both once at startup covers
// every caller: a call slower than SLOW_SYNC_IO_MS logs `sync_fs_slow` /
// `sync_db_slow` with the op, its path/SQL label, and the call-site frame.
//
// Logging a slow fs call is itself a sync fs write (pino transport); the
// insideReport guard in slowOpLog stops that from recursing. Only the main
// thread reports — workers have their own module copies and their blocking
// does not stall the UI loop.

import fs from 'node:fs'
import { Database } from 'bun:sqlite'
import { logSlowOp } from './slowOpLog'

// fs calls are normally single-digit microseconds of syscall + page-cache
// time; 100ms means the read went to disk under pressure (or worse).
export const SLOW_SYNC_IO_MS = 100
export const SLOW_SYNC_IO_OUTLIER_MS = 1000
export const SLOW_SYNC_IO_AGGREGATE_MS = 60_000

// Sync fs surface the server can stall on. existsSync is included: under a
// wedged filesystem even metadata probes block.
const FS_METHODS = [
  'readFileSync',
  'readSync',
  'writeFileSync',
  'appendFileSync',
  'writeSync',
  'statSync',
  'lstatSync',
  'fstatSync',
  'readdirSync',
  'realpathSync',
  'existsSync',
  'mkdirSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'copyFileSync',
] as const

// Statement methods that can issue pread against the db file. iterate()
// is wrapped per next() call — a stall mid-scan attributes to the step.
const STMT_METHODS = ['run', 'get', 'all', 'values', 'iterate'] as const

const PATH_ARG_METHODS = new Set([
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'statSync',
  'lstatSync',
  'readdirSync',
  'realpathSync',
  'existsSync',
  'mkdirSync',
  'renameSync',
  'unlinkSync',
  'rmSync',
  'copyFileSync',
])

let installed = false

/** First stack frame outside the instrumentation modules; undefined if none. */
function callSite(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  for (const line of stack.split('\n')) {
    if (!line.includes('at ')) continue
    if (
      line.includes('syncIoTiming.ts') ||
      line.includes('slowOpLog.ts') ||
      line.includes('node:fs') ||
      line.includes('bun:sqlite')
    ) {
      continue
    }
    return line.trim().slice(0, 160)
  }
  return undefined
}

function report(event: string, key: string, durationMs: number, fields: Record<string, unknown>): void {
  logSlowOp({
    event,
    key,
    durationMs,
    thresholdMs: SLOW_SYNC_IO_MS,
    outlierMs: SLOW_SYNC_IO_OUTLIER_MS,
    aggregateMs: SLOW_SYNC_IO_AGGREGATE_MS,
    fields: durationMs >= SLOW_SYNC_IO_MS ? { ...fields, site: callSite() } : fields,
  })
}

function sqlLabel(sql: unknown): string {
  return typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
}

type AnyFn = (this: unknown, ...args: never[]) => unknown

const wrappedStmts = new WeakSet<object>()

function wrapStatement(stmt: object, sql: unknown): void {
  if (wrappedStmts.has(stmt)) return
  wrappedStmts.add(stmt)
  const rec = stmt as unknown as Record<string, unknown>
  for (const method of STMT_METHODS) {
    const orig = rec[method]
    if (typeof orig !== 'function') continue
    if (method === 'iterate') {
      rec[method] = function (...args: unknown[]) {
        const iterator = (orig as AnyFn).apply(this, args as never[]) as Iterator<unknown>
        return {
          [Symbol.iterator]() {
            return this
          },
          next: () => {
            const startedAt = performance.now()
            const step = iterator.next()
            report('sync_db_slow', `db.stmt.iterate`, performance.now() - startedAt, {
              op: `db.stmt.${method}`,
              sql: sqlLabel(sql),
            })
            return step
          },
        }
      }
    } else {
      rec[method] = function (...args: unknown[]) {
        const startedAt = performance.now()
        try {
          return (orig as AnyFn).apply(this, args as never[])
        } finally {
          report('sync_db_slow', `db.stmt.${method}`, performance.now() - startedAt, {
            op: `db.stmt.${method}`,
            sql: sqlLabel(sql),
          })
        }
      }
    }
  }
}

export function wrapFs(fsImpl: typeof fs): void {
  const rec = fsImpl as unknown as Record<string, unknown>
  for (const name of FS_METHODS) {
    const orig = rec[name]
    if (typeof orig !== 'function') continue
    rec[name] = function (...args: unknown[]) {
      const startedAt = performance.now()
      try {
        return (orig as AnyFn).apply(this, args as never[])
      } finally {
        const durationMs = performance.now() - startedAt
        if (durationMs >= SLOW_SYNC_IO_MS) {
          const target = PATH_ARG_METHODS.has(name)
            ? { path: typeof args[0] === 'string' ? args[0].slice(0, 200) : args[0] }
            : { fd: typeof args[0] === 'number' ? args[0] : undefined }
          report('sync_fs_slow', `fs.${name}`, durationMs, { op: `fs.${name}`, ...target })
        }
      }
    }
  }
}

export function wrapDatabase(dbCtor: { prototype: unknown }): void {
  const proto = dbCtor.prototype as Record<string, unknown>

  for (const name of ['exec', 'run'] as const) {
    const orig = proto[name]
    if (typeof orig !== 'function') continue
    proto[name] = function (...args: unknown[]) {
      const startedAt = performance.now()
      try {
        return (orig as AnyFn).apply(this, args as never[])
      } finally {
        report('sync_db_slow', `db.${name}`, performance.now() - startedAt, {
          op: `db.${name}`,
          sql: sqlLabel(args[0]),
        })
      }
    }
  }

  for (const name of ['prepare', 'query'] as const) {
    const orig = proto[name]
    if (typeof orig !== 'function') continue
    proto[name] = function (...args: unknown[]) {
      const startedAt = performance.now()
      const stmt = (orig as AnyFn).apply(this, args as never[])
      const prepareMs = performance.now() - startedAt
      report('sync_db_slow', `db.${name}`, prepareMs, {
        op: `db.${name}`,
        sql: sqlLabel(args[0]),
      })
      if (stmt && typeof stmt === 'object') wrapStatement(stmt, args[0])
      return stmt
    }
  }

  const origTransaction = proto.transaction
  if (typeof origTransaction === 'function') {
    proto.transaction = function (...args: unknown[]) {
      const txn = (origTransaction as AnyFn).apply(this, args as never[])
      if (typeof txn !== 'function') return txn
      // transaction() returns a callable carrying .deferred/.immediate/
      // .exclusive variants — preserve every attached method, timed alike.
      const timeCall = (fn: AnyFn, label: string, callArgs: unknown[]) => {
        const startedAt = performance.now()
        try {
          return fn.apply(this, callArgs as never[])
        } finally {
          report('sync_db_slow', 'db.transaction', performance.now() - startedAt, {
            op: label,
          })
        }
      }
      const wrapped = (...txnArgs: unknown[]) =>
        timeCall(txn as AnyFn, 'db.transaction', txnArgs)
      const txnObj = txn as unknown as Record<PropertyKey, unknown>
      const wrappedObj = wrapped as unknown as Record<PropertyKey, unknown>
      for (const key of Reflect.ownKeys(txn)) {
        if (key === 'length' || key === 'name') continue
        const value = txnObj[key]
        wrappedObj[key] =
          typeof value === 'function'
            ? (...txnArgs: unknown[]) =>
                timeCall(value as AnyFn, `db.transaction.${String(key)}`, txnArgs)
            : value
      }
      return wrapped
    }
  }
}

/**
 * Wrap fs sync methods and bun:sqlite Database/Statement once. Call early in
 * server startup so slow calls during hydration are covered.
 */
export function installSyncIoTiming(): void {
  if (installed) return
  installed = true
  wrapFs(fs)
  wrapDatabase(Database)
}
