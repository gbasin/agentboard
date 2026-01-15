import { afterAll, describe, expect, test } from 'bun:test'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
}

const originalServe = bunAny.serve
const originalSpawnSync = bunAny.spawnSync
const originalSetInterval = globalThis.setInterval
const originalMatchWorker = process.env.AGENTBOARD_LOG_MATCH_WORKER

const serveCalls: Array<{ port: number }> = []
const importIndex = (suffix: string) => import(`../index?test=${suffix}`)

describe('server entrypoint', () => {
  test('starts server without side effects', async () => {
    serveCalls.length = 0
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    bunAny.spawnSync = () =>
      ({
        exitCode: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
      }) as ReturnType<typeof Bun.spawnSync>
    bunAny.serve = ((options: { port?: number }) => {
      serveCalls.push({ port: options.port ?? 0 })
      return {} as ReturnType<typeof Bun.serve>
    }) as unknown as typeof Bun.serve
    globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval

    await importIndex('no-side-effects')

    const expectedPort = Number(process.env.PORT) || 4040
    expect(serveCalls).toHaveLength(1)
    expect(serveCalls[0]?.port).toBe(expectedPort)
  })

  test('starts server when lsof is unavailable', async () => {
    serveCalls.length = 0
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    bunAny.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
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
    bunAny.serve = ((options: { port?: number }) => {
      serveCalls.push({ port: options.port ?? 0 })
      return {} as ReturnType<typeof Bun.serve>
    }) as unknown as typeof Bun.serve
    globalThis.setInterval = (() => 0) as unknown as typeof globalThis.setInterval

    await importIndex('missing-lsof')

    const expectedPort = Number(process.env.PORT) || 4040
    expect(serveCalls).toHaveLength(1)
    expect(serveCalls[0]?.port).toBe(expectedPort)
  })
})

afterAll(() => {
  bunAny.serve = originalServe
  bunAny.spawnSync = originalSpawnSync
  globalThis.setInterval = originalSetInterval
  if (originalMatchWorker === undefined) {
    delete process.env.AGENTBOARD_LOG_MATCH_WORKER
  } else {
    process.env.AGENTBOARD_LOG_MATCH_WORKER = originalMatchWorker
  }
})
