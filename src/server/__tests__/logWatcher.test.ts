import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

const originalLogFile = process.env.LOG_FILE
let LogWatcher: typeof import('../logWatcher').LogWatcher

/** Single cast point for accessing LogWatcher internals in tests */
interface LogWatcherInternals {
  handleEvent: (filePath: string) => void
  shouldWatchPath: (
    filePath: string,
    stats?: { isFile(): boolean; isDirectory(): boolean }
  ) => boolean
  resolveWatchDirs: (dirs: string[]) => string[]
}

function internals(watcher: InstanceType<typeof LogWatcher>): LogWatcherInternals {
  return watcher as unknown as LogWatcherInternals
}

afterEach(() => {
  jest.useRealTimers()
})

beforeAll(async () => {
  process.env.LOG_FILE = path.join(
    os.tmpdir(),
    `agentboard-logwatcher-${process.pid}-${Date.now()}.log`
  )
  ;({ LogWatcher } = await import(`../logWatcher?watcher-test=${Date.now()}`))
})

afterAll(() => {
  if (originalLogFile === undefined) {
    delete process.env.LOG_FILE
  } else {
    process.env.LOG_FILE = originalLogFile
  }
})

describe('LogWatcher', () => {
  test('debounces rapid events into one batch', () => {
    jest.useFakeTimers()
    const batches: string[][] = []
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      debounceMs: 2000,
      maxWaitMs: 5000,
      onBatch: (paths) => batches.push(paths),
    })

    internals(watcher).handleEvent('/tmp/one.jsonl')
    jest.advanceTimersByTime(1000)
    internals(watcher).handleEvent('/tmp/two.jsonl')
    jest.advanceTimersByTime(1999)
    expect(batches).toHaveLength(0)

    jest.advanceTimersByTime(1)
    expect(batches).toHaveLength(1)
    expect(new Set(batches[0])).toEqual(new Set(['/tmp/one.jsonl', '/tmp/two.jsonl']))
  })

  test('flushes when maxWait is reached even with continuous events', () => {
    jest.useFakeTimers()
    const batches: string[][] = []
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      debounceMs: 2000,
      maxWaitMs: 5000,
      onBatch: (paths) => batches.push(paths),
    })

    for (let i = 0; i < 11; i += 1) {
      internals(watcher).handleEvent(`/tmp/${i}.jsonl`)
      jest.advanceTimersByTime(500)
    }

    expect(batches.length).toBeGreaterThanOrEqual(1)
    expect(batches[0]?.length).toBeGreaterThan(0)
  })

  test('deduplicates paths within a batch', () => {
    jest.useFakeTimers()
    const batches: string[][] = []
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      debounceMs: 50,
      maxWaitMs: 5000,
      onBatch: (paths) => batches.push(paths),
    })

    internals(watcher).handleEvent('/tmp/duplicate.jsonl')
    internals(watcher).handleEvent('/tmp/duplicate.jsonl')
    internals(watcher).handleEvent('/tmp/duplicate.jsonl')

    jest.advanceTimersByTime(50)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual(['/tmp/duplicate.jsonl'])
  })

  test('stop flushes pending paths immediately', () => {
    jest.useFakeTimers()
    const batches: string[][] = []
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      debounceMs: 2000,
      maxWaitMs: 5000,
      onBatch: (paths) => batches.push(paths),
    })

    internals(watcher).handleEvent('/tmp/pending.jsonl')
    watcher.stop()

    expect(batches).toHaveLength(1)
    expect(batches[0]).toEqual(['/tmp/pending.jsonl'])
  })

  test('filters paths to jsonl files while allowing directory traversal', () => {
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      onBatch: () => {},
    })
    const { shouldWatchPath } = internals(watcher)

    expect(
      shouldWatchPath('/tmp/included.jsonl', {
        isFile: () => true,
        isDirectory: () => false,
      })
    ).toBe(true)
    expect(
      shouldWatchPath('/tmp/ignored.txt', {
        isFile: () => true,
        isDirectory: () => false,
      })
    ).toBe(false)
    expect(
      shouldWatchPath('/tmp/some-dir', {
        isFile: () => false,
        isDirectory: () => true,
      })
    ).toBe(true)
  })

  test('resolves non-existent watch directories to existing ancestors', async () => {
    const fs = await import('node:fs/promises')
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logwatcher-missing-'))
    const missingDir = path.join(tempRoot, 'later', 'nested')
    const watcher = new LogWatcher({
      dirs: [missingDir],
      depth: 5,
      onBatch: () => {},
    })
    const resolved = internals(watcher).resolveWatchDirs([missingDir])

    try {
      expect(resolved).toEqual([tempRoot])
      watcher.start()
      watcher.stop()
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('skips directories that would resolve to home or root', () => {
    const watcher = new LogWatcher({
      dirs: [],
      depth: 5,
      onBatch: () => {},
    })
    const { resolveWatchDirs } = internals(watcher)

    // A non-existent child of home walks up to home — should be skipped
    const fakeDir = path.join(os.homedir(), 'nonexistent-agent-dir-xyz')
    expect(resolveWatchDirs([fakeDir])).toEqual([])

    // Root should also be skipped
    expect(resolveWatchDirs(['/'])).toEqual([])
  })
})
