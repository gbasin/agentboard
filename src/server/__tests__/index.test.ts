import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
}

const originalServe = bunAny.serve
const originalSpawnSync = bunAny.spawnSync
const originalSetInterval = globalThis.setInterval
const originalMatchWorker = process.env.AGENTBOARD_LOG_MATCH_WORKER
const originalDbPath = process.env.AGENTBOARD_DB_PATH
let tempDbPath: string | null = null

const serveCalls: Array<{ port: number }> = []
let importCounter = 0
let spawnSyncImpl: typeof Bun.spawnSync

describe('server entrypoint', () => {
  beforeAll(() => {
    const suffix = `index-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
    tempDbPath = path.join(os.tmpdir(), `agentboard-${suffix}.db`)
    process.env.AGENTBOARD_DB_PATH = tempDbPath
  })

  beforeEach(() => {
    serveCalls.length = 0
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    
    // Default mock: port not in use
    spawnSyncImpl = () =>
      ({
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      }) as ReturnType<typeof Bun.spawnSync>

    bunAny.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) =>
      spawnSyncImpl(...args)) as typeof Bun.spawnSync
    bunAny.serve = ((options: { port?: number }) => {
      serveCalls.push({ port: options.port ?? 0 })
      return {} as ReturnType<typeof Bun.serve>
    }) as unknown as typeof Bun.serve
    globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval
  })

  afterEach(() => {
    bunAny.serve = originalServe
    bunAny.spawnSync = originalSpawnSync
    globalThis.setInterval = originalSetInterval
  })

  test('starts server without side effects', async () => {
    importCounter += 1
    await import(`../index?test=no-side-effects-${importCounter}`)

    const expectedPort = Number(process.env.PORT) || 4040
    expect(serveCalls).toHaveLength(1)
    expect(serveCalls[0]?.port).toBe(expectedPort)
  })

  test('starts server when lsof is unavailable', async () => {
    // Override spawnSyncImpl to throw for lsof
    spawnSyncImpl = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = Array.isArray(args[0]) ? args[0][0] : ''
      if (command === 'lsof') {
        throw new Error('missing lsof')
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    importCounter += 1
    await import(`../index?test=missing-lsof-${importCounter}`)

    const expectedPort = Number(process.env.PORT) || 4040
    expect(serveCalls).toHaveLength(1)
    expect(serveCalls[0]?.port).toBe(expectedPort)
  })
})

afterAll(() => {
  bunAny.serve = originalServe
  bunAny.spawnSync = originalSpawnSync
  globalThis.setInterval = originalSetInterval
  if (originalDbPath === undefined) {
    delete process.env.AGENTBOARD_DB_PATH
  } else {
    process.env.AGENTBOARD_DB_PATH = originalDbPath
  }
  if (tempDbPath) {
    fs.rm(tempDbPath, { force: true }).catch(() => {})
  }
  if (originalMatchWorker === undefined) {
    delete process.env.AGENTBOARD_LOG_MATCH_WORKER
  } else {
    process.env.AGENTBOARD_LOG_MATCH_WORKER = originalMatchWorker
  }
})
