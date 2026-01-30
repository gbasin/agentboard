import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// Mock logger to suppress expected error output during port conflict tests
mock.module('../logger', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
  flushLogger: () => {},
  closeLogger: () => {},
}))

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
}

const processAny = process as typeof process & {
  exit: typeof process.exit
}

const originalServe = bunAny.serve
const originalSpawnSync = bunAny.spawnSync
const originalProcessExit = processAny.exit
const originalSetInterval = globalThis.setInterval
const originalDbPath = process.env.AGENTBOARD_DB_PATH
let tempDbPath: string | null = null
let importCounter = 0

beforeAll(() => {
  const suffix = `port-check-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  tempDbPath = path.join(os.tmpdir(), `agentboard-${suffix}.db`)
  process.env.AGENTBOARD_DB_PATH = tempDbPath
})

beforeEach(() => {
  // Set up mocks that simulate port already in use
  bunAny.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
    const command = Array.isArray(args[0]) ? args[0][0] : ''
    if (command === 'lsof') {
      return {
        exitCode: 0,
        stdout: Buffer.from('123\n'),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (command === 'ps') {
      return {
        exitCode: 0,
        stdout: Buffer.from('node\n'),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync

  bunAny.serve = ((_options: Parameters<typeof Bun.serve>[0]) => {
    return {} as ReturnType<typeof Bun.serve>
  }) as typeof Bun.serve

  globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval

  processAny.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`)
  }) as typeof processAny.exit
})

afterEach(() => {
  bunAny.serve = originalServe
  bunAny.spawnSync = originalSpawnSync
  processAny.exit = originalProcessExit
  globalThis.setInterval = originalSetInterval
})

afterAll(() => {
  if (originalDbPath === undefined) {
    delete process.env.AGENTBOARD_DB_PATH
  } else {
    process.env.AGENTBOARD_DB_PATH = originalDbPath
  }
  if (tempDbPath) {
    fs.rm(tempDbPath, { force: true }).catch(() => {})
  }
})

describe('port availability', () => {
  test('exits when the configured port is already in use', async () => {
    importCounter += 1
    const suffix = `port-check-${importCounter}`

    let thrown: Error | null = null
    try {
      await import(`../index?test=${suffix}`)
    } catch (error) {
      thrown = error as Error
    }

    // Core behavior: server should exit with code 1 when port is in use
    // Note: Log output is tested separately in logger.test.ts
    expect(thrown?.message).toBe('exit:1')
  })
})
