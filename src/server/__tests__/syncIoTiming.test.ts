// syncIoTiming.test.ts - slow fs/sqlite wrappers log events without recursion
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { logger } from '../logger'
import { resetSlowOpState } from '../slowOpLog'
import {
  resetSyncIoAccumulators,
  SLOW_SYNC_IO_MS,
  wrapDatabase,
  wrapFs,
} from '../syncIoTiming'

type LogCall = { level: 'warn' | 'debug'; event: string; data?: Record<string, unknown> }

const originalWarn = logger.warn
const originalDebug = logger.debug
let calls: LogCall[] = []

const isIoEvent = (event: string) => /^sync_(fs|db)_slow/.test(event)

/** Real delay so the wrapper measures it — deterministic, no clock injection. */
function busyWait(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {}
}

beforeEach(() => {
  calls = []
  resetSlowOpState()
  resetSyncIoAccumulators()
  logger.warn = (event, data) => {
    if (isIoEvent(event)) calls.push({ level: 'warn', event, data })
  }
  logger.debug = (event, data) => {
    if (isIoEvent(event)) calls.push({ level: 'debug', event, data })
  }
})

afterEach(() => {
  logger.warn = originalWarn
  logger.debug = originalDebug
})

describe('wrapFs', () => {
  test('a slow sync call logs sync_fs_slow with op, path and site', () => {
    const fakeFs = {
      readFileSync: (path: string) => {
        busyWait(SLOW_SYNC_IO_MS + 30)
        return path
      },
    }
    wrapFs(fakeFs as never)
    fakeFs.readFileSync('/tmp/x.jsonl')
    expect(calls).toHaveLength(1)
    const { event, data } = calls[0]
    expect(event).toBe('sync_fs_slow')
    expect(data?.op).toBe('fs.readFileSync')
    expect(data?.path).toBe('/tmp/x.jsonl')
    expect(typeof data?.site).toBe('string')
    expect(data?.durationMs as number).toBeGreaterThanOrEqual(SLOW_SYNC_IO_MS)
  })

  test('a fast call logs nothing', () => {
    const fakeFs = { readFileSync: () => 'x' }
    wrapFs(fakeFs as never)
    fakeFs.readFileSync()
    expect(calls).toHaveLength(0)
  })

  test('a second slow call in-window is suppressed, not re-warned', () => {
    const fakeFs = {
      statSync: () => busyWait(SLOW_SYNC_IO_MS + 20),
    }
    wrapFs(fakeFs as never)
    fakeFs.statSync()
    fakeFs.statSync()
    expect(calls.filter((c) => c.event === 'sync_fs_slow')).toHaveLength(1)
  })

  test('sub-threshold calls accumulate and report once over the threshold', () => {
    const fakeFs = {
      readFileSync: () => busyWait(60),
    }
    wrapFs(fakeFs as never)
    fakeFs.readFileSync()
    expect(calls).toHaveLength(0) // 60ms alone is below the bar
    fakeFs.readFileSync()
    const hit = calls.find((c) => c.event === 'sync_fs_slow')
    expect(hit?.data?.accumulated).toBe(true)
    expect(hit?.data?.calls).toBe(2)
    expect(hit?.data?.durationMs as number).toBeGreaterThanOrEqual(SLOW_SYNC_IO_MS)
  })

  test('distinct paths get separate suppression windows', () => {
    const fakeFs = {
      readFileSync: (_path?: string) => busyWait(SLOW_SYNC_IO_MS + 20),
    }
    wrapFs(fakeFs as never)
    fakeFs.readFileSync('/a.jsonl')
    fakeFs.readFileSync('/b.jsonl')
    // Per-path keys: a second file's first slow call warns rather than being
    // absorbed by /a's window.
    expect(calls.filter((c) => c.event === 'sync_fs_slow')).toHaveLength(2)
    const paths = calls.map((c) => c.data?.path).sort()
    expect(paths).toEqual(['/a.jsonl', '/b.jsonl'])
  })

  test('logging inside the warn hook does not recurse', () => {
    const fakeFs = {
      readFileSync: () => busyWait(SLOW_SYNC_IO_MS + 20),
    }
    wrapFs(fakeFs as never)
    logger.warn = (event, data) => {
      if (!isIoEvent(event)) return
      calls.push({ level: 'warn', event, data })
      // The pino write path itself issues sync fs calls; those must not
      // re-enter the slow-op logger.
      fakeFs.readFileSync()
    }
    fakeFs.readFileSync()
    expect(calls).toHaveLength(1)
  })
})

describe('wrapDatabase', () => {
  test('statement execution logs sync_db_slow with the sql label', () => {
    class FakeStmt {
      all() {
        busyWait(SLOW_SYNC_IO_MS + 30)
        return []
      }
    }
    class FakeDb {
      prepare(_sql: string) {
        return new FakeStmt()
      }
    }
    wrapDatabase(FakeDb as never)
    const db = new FakeDb()
    db.prepare('SELECT *\nFROM sessions WHERE id = ?').all()
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit).toBeTruthy()
    expect(hit?.data?.op).toBe('db.stmt.all')
    expect(hit?.data?.sql).toBe('SELECT * FROM sessions WHERE id = ?')
  })

  test('db.exec is timed directly', () => {
    class FakeDb {
      exec() {
        busyWait(SLOW_SYNC_IO_MS + 30)
      }
    }
    wrapDatabase(FakeDb as never)
    new FakeDb().exec()
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit?.data?.op).toBe('db.exec')
  })

  test('transaction invocations are timed', () => {
    class FakeDb {
      transaction(fn: () => void) {
        return () => {
          busyWait(SLOW_SYNC_IO_MS + 30)
          fn()
        }
      }
    }
    wrapDatabase(FakeDb as never)
    const txn = new FakeDb().transaction(() => {})
    txn()
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit?.data?.op).toBe('db.transaction')
  })

  test('transaction variants (.immediate etc.) survive the wrapper', () => {
    class FakeDb {
      transaction(fn: () => void) {
        const txn = () => fn()
        ;(txn as { immediate?: () => void }).immediate = () => {
          busyWait(SLOW_SYNC_IO_MS + 30)
          fn()
        }
        return txn
      }
    }
    wrapDatabase(FakeDb as never)
    const txn = new FakeDb().transaction(() => {}) as unknown as {
      (): void
      immediate: () => void
    }
    expect(typeof txn.immediate).toBe('function')
    txn.immediate()
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit?.data?.op).toBe('db.transaction.immediate')
  })

  test('transaction self-references (txn.default) point at the wrapper', () => {
    class FakeDb {
      transaction(fn: () => void) {
        const txn = () => fn()
        const txnObj = txn as { default?: unknown }
        txnObj.default = txn
        return txn
      }
    }
    wrapDatabase(FakeDb as never)
    const txn = new FakeDb().transaction(() => {}) as unknown as {
      (): void
      default: () => void
    }
    expect(txn.default).toBe(txn)
  })

  test('a failed prepare still gets timed', () => {
    class FakeDb {
      prepare(_sql: string) {
        busyWait(SLOW_SYNC_IO_MS + 30)
        throw new Error('syntax error')
      }
    }
    wrapDatabase(FakeDb as never)
    expect(() => new FakeDb().prepare('garbage')).toThrow('syntax error')
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit?.data?.op).toBe('db.prepare')
  })

  test('iterate times each step', () => {
    class FakeStmt {
      *iterate() {
        busyWait(SLOW_SYNC_IO_MS + 30)
        yield 1
      }
    }
    class FakeDb {
      query(_sql: string) {
        return new FakeStmt()
      }
    }
    wrapDatabase(FakeDb as never)
    for (const _ of new FakeDb().query('SELECT 1').iterate()) {
      void _
    }
    const hit = calls.find((c) => c.event === 'sync_db_slow')
    expect(hit?.data?.op).toBe('db.stmt.iterate')
  })

  test('a cached statement is not double-wrapped', () => {
    const stmt = {
      all: () => {
        busyWait(SLOW_SYNC_IO_MS + 30)
        return []
      },
    }
    class FakeDb {
      prepare(_sql: string) {
        return stmt // bun:sqlite caches statements per sql
      }
    }
    wrapDatabase(FakeDb as never)
    const db = new FakeDb()
    db.prepare('A').all()
    db.prepare('A').all() // second prepare returns the same stmt object
    // One warn for the first slow call, zero for the suppressed second —
    // not two warnings from a double-applied wrapper.
    expect(calls.filter((c) => c.event === 'sync_db_slow')).toHaveLength(1)
  })
})
