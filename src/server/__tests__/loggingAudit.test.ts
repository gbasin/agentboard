import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  formatLoggingAuditReport,
  runLoggingAudit,
} from '../loggingAudit'

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

async function createServerFile(
  rootDir: string,
  relativePath: string,
  content: string
): Promise<void> {
  const fullPath = path.join(rootDir, relativePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content)
}

async function createTempRoot(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logging-audit-'))
  tempDirs.push(rootDir)
  return rootDir
}

describe('loggingAudit', () => {
  test('flags unlogged catch blocks in high-impact files', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/index.ts',
      `
      const app = { get: (..._args: unknown[]) => {} }

      export function handler() {
        app.get('/api/thing', async () => {
          try {
            throw new Error('boom')
          } catch {
            return 'x'
          }
        })
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toContainEqual({
      severity: 'high',
      rule: 'catch_without_logging',
      file: 'src/server/index.ts',
      line: 8,
      message: 'catch block does not emit a structured logger event',
    })
  })

  test('supports intentional catch suppression markers', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/SessionManager.ts',
      `
      export function syncState() {
        try {
          throw new Error('boom')
        } catch {
          /* logging-audit:intentional */
          return null
        }
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toEqual([])
  })

  test('flags non-snake events and missing catch error context', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/db.ts',
      `
      import { logger } from './logger'

      export function migrate() {
        try {
          throw new Error('bad')
        } catch (error) {
          logger.warn('BadEventName', { detail: 'missing error fields' })
        }
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toEqual([
      {
        severity: 'high',
        rule: 'missing_error_context',
        file: 'src/server/db.ts',
        line: 8,
        message: 'logger.warn("BadEventName") is missing error context fields',
      },
      {
        severity: 'medium',
        rule: 'non_snake_case_event_name',
        file: 'src/server/db.ts',
        line: 8,
        message: 'event "BadEventName" is not snake_case',
      },
    ])

    const output = formatLoggingAuditReport(report)
    expect(output).toContain('HIGH missing_error_context src/server/db.ts:8')
    expect(output).toContain('MEDIUM non_snake_case_event_name src/server/db.ts:8')
  })

  test('does not count logger calls inside nested functions as catch logging', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/index.ts',
      `
      import { logger } from './logger'
      const app = { get: (..._args: unknown[]) => {} }

      export function handler() {
        app.get('/api/thing', async () => {
          try {
            throw new Error('boom')
          } catch {
            const deferred = () => {
              logger.warn('deferred_error', { error_message: 'later' })
            }
            return deferred
          }
        })
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toContainEqual({
      severity: 'high',
      rule: 'catch_without_logging',
      file: 'src/server/index.ts',
      line: 9,
      message: 'catch block does not emit a structured logger event',
    })
  })

  test('does not treat suppression markers inside strings as intentional', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/SessionManager.ts',
      `
      export function syncState() {
        try {
          throw new Error('boom')
        } catch {
          const note = 'logging-audit:intentional'
          return note
        }
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toContainEqual({
      severity: 'medium',
      rule: 'catch_without_logging',
      file: 'src/server/SessionManager.ts',
      line: 5,
      message: 'catch block does not emit a structured logger event',
    })
  })

  test('flags non-object logger context that lacks error signals', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/index.ts',
      `
      import { logger } from './logger'
      const app = { get: (..._args: unknown[]) => {} }

      export function handler() {
        app.get('/api/thing', async () => {
          try {
            throw new Error('boom')
          } catch (error) {
            const details = { reason: 'none' }
            logger.error('route_failed', details)
            return error
          }
        })
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toContainEqual({
      severity: 'high',
      rule: 'missing_error_context',
      file: 'src/server/index.ts',
      line: 11,
      message: 'logger.error("route_failed") is missing error context fields',
    })
  })

  test('supports logger bracket syntax in catch logging', async () => {
    const rootDir = await createTempRoot()
    await createServerFile(
      rootDir,
      'src/server/index.ts',
      `
      import { logger } from './logger'
      const app = { get: (..._args: unknown[]) => {} }

      export function handler() {
        app.get('/api/thing', async () => {
          try {
            throw new Error('boom')
          } catch (error) {
            logger['warn']('route_warned', { error_message: String(error) })
            return null
          }
        })
      }
      `
    )

    const report = await runLoggingAudit({ rootDir })
    expect(report.findings).toEqual([])
  })
})
