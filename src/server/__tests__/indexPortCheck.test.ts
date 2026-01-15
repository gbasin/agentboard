import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

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
const originalConsoleError = console.error
const originalSetInterval = globalThis.setInterval
const originalDbPath = process.env.AGENTBOARD_DB_PATH
let tempDbPath: string | null = null

beforeAll(() => {
  const suffix = `port-check-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
  tempDbPath = path.join(os.tmpdir(), `agentboard-${suffix}.db`)
  process.env.AGENTBOARD_DB_PATH = tempDbPath
})

afterEach(() => {
  bunAny.serve = originalServe
  bunAny.spawnSync = originalSpawnSync
  processAny.exit = originalProcessExit
  console.error = originalConsoleError
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
    const errors: string[] = []
    console.error = (message?: unknown) => {
      if (typeof message === 'string') {
        errors.push(message)
      }
    }

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

    let thrown: Error | null = null
    try {
      const suffix = 'port-check'
      await import(`../index?test=${suffix}`)
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown?.message).toBe('exit:1')
    expect(errors.length).toBeGreaterThan(0)
    const logEntry = JSON.parse(errors[0])
    expect(logEntry.event).toBe('port_in_use')
    expect(logEntry.port).toBe(Number(process.env.PORT) || 4040)
    expect(logEntry.level).toBe('error')
  })
})
