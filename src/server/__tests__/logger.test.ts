import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

async function removeDirWithRetries(dirPath: string): Promise<void> {
  let lastError: unknown = null

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rm(dirPath, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw error
      }
      lastError = error
      await Bun.sleep(25 * (attempt + 1))
    }
  }

  throw lastError
}

describe('logger', () => {
  const ORIGINAL_LOG_LEVEL = process.env.LOG_LEVEL
  const ORIGINAL_LOG_FILE = process.env.LOG_FILE
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV

  // Track imported modules for cleanup
  let closeLogger: (() => void) | null = null

  afterEach(() => {
    // Close logger to release resources
    if (closeLogger) {
      closeLogger()
      closeLogger = null
    }

    // Restore env vars
    if (ORIGINAL_LOG_LEVEL === undefined) {
      delete process.env.LOG_LEVEL
    } else {
      process.env.LOG_LEVEL = ORIGINAL_LOG_LEVEL
    }
    if (ORIGINAL_LOG_FILE === undefined) {
      delete process.env.LOG_FILE
    } else {
      process.env.LOG_FILE = ORIGINAL_LOG_FILE
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV
    }
  })

  test('logger exports expected interface', async () => {
    const mod = await import(`../logger?iface-${Date.now()}`)
    closeLogger = mod.closeLogger

    expect(typeof mod.logger.debug).toBe('function')
    expect(typeof mod.logger.info).toBe('function')
    expect(typeof mod.logger.warn).toBe('function')
    expect(typeof mod.logger.error).toBe('function')
    expect(typeof mod.flushLogger).toBe('function')
    expect(typeof mod.closeLogger).toBe('function')
  })

  test('writes to log file when LOG_FILE is set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?file-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.info('test_event', { foo: 'bar' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).toContain('test_event')
    expect(content).toContain('foo')

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })

  test('logger respects log level from env', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'warn'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?level-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.logger.warn('warn_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('debug_event')
    expect(content).not.toContain('info_event')
    expect(content).toContain('warn_event')

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })

  test('defaults to info level when LOG_LEVEL not set', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    delete process.env.LOG_LEVEL
    process.env.LOG_FILE = logFile
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?default-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    expect(content).not.toContain('debug_event')
    expect(content).toContain('info_event')

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })

  test('handles invalid LOG_LEVEL gracefully', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_LEVEL = 'invalid'
    process.env.LOG_FILE = logFile
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?invalid-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.debug('debug_event')
    mod.logger.info('info_event')
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    // Should default to info level
    expect(content).not.toContain('debug_event')
    expect(content).toContain('info_event')

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })

  test('log entries include event name in output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?event-${Date.now()}`)
    closeLogger = mod.closeLogger

    mod.logger.info('my_custom_event', { key: 'value' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    const lines = content.trim().split('\n')
    const entry = JSON.parse(lines[0])

    expect(entry.event).toBe('my_custom_event')
    expect(entry.key).toBe('value')
    expect(entry.level).toBe(30) // pino info level number

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })

  test('event field is not overwritten by data', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'))
    const logFile = path.join(tmpDir, 'test.log')

    process.env.LOG_FILE = logFile
    process.env.LOG_LEVEL = 'info'
    process.env.NODE_ENV = 'production'

    const mod = await import(`../logger?override-${Date.now()}`)
    closeLogger = mod.closeLogger

    // Pass data that tries to override event field
    mod.logger.info('correct_event', { event: 'wrong_event', other: 'data' })
    mod.flushLogger()

    const content = fs.readFileSync(logFile, 'utf-8')
    const entry = JSON.parse(content.trim())

    expect(entry.event).toBe('correct_event')
    expect(entry.other).toBe('data')

    mod.closeLogger()
    closeLogger = null
    await removeDirWithRetries(tmpDir)
  })
})
