import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type {
  DirectoryListing,
  DirectoryErrorResponse,
} from '@shared/types'

const bunAny = Bun as typeof Bun & {
  serve: typeof Bun.serve
  spawnSync: typeof Bun.spawnSync
}

const processAny = process as typeof process & {
  on: typeof process.on
  exit: typeof process.exit
}

const originalServe = bunAny.serve
const originalSpawnSync = bunAny.spawnSync
const originalSetInterval = globalThis.setInterval
const originalConsoleLog = console.log
const originalConsoleError = console.error
const originalProcessOn = processAny.on
const originalProcessExit = processAny.exit

let serveOptions: Parameters<typeof Bun.serve>[0] | null = null
let spawnSyncImpl: typeof Bun.spawnSync
let importCounter = 0

async function loadIndex() {
  importCounter += 1
  const originalLogPoll = process.env.AGENTBOARD_LOG_POLL_MS
  process.env.AGENTBOARD_LOG_POLL_MS = '0'
  try {
    await import(`../index?directories=${importCounter}`)
  } finally {
    if (originalLogPoll === undefined) {
      delete process.env.AGENTBOARD_LOG_POLL_MS
    } else {
      process.env.AGENTBOARD_LOG_POLL_MS = originalLogPoll
    }
  }
  if (!serveOptions) {
    throw new Error('Bun.serve was not called')
  }
  return serveOptions
}

async function fetchDirectories(requestedPath: string) {
  const { fetch } = await loadIndex()
  if (!fetch) {
    throw new Error('Fetch handler not configured')
  }
  const server = {} as Bun.Server<unknown>
  const url = new URL('http://localhost/api/directories')
  url.searchParams.set('path', requestedPath)
  const response = await fetch.call(
    server,
    new Request(url.toString()),
    server
  )
  if (!response) {
    throw new Error('Expected response from directory handler')
  }
  return response
}

beforeEach(() => {
  serveOptions = null
  spawnSyncImpl = () =>
    ({
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    }) as ReturnType<typeof Bun.spawnSync>

  bunAny.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) =>
    spawnSyncImpl(...args)) as typeof Bun.spawnSync
  bunAny.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
    serveOptions = options
    return {} as ReturnType<typeof Bun.serve>
  }) as typeof Bun.serve
  globalThis.setInterval = ((..._args: Parameters<typeof globalThis.setInterval>) =>
    0) as unknown as typeof globalThis.setInterval
  console.log = () => {}
  console.error = () => {}
  processAny.on = (() => processAny) as typeof processAny.on
  processAny.exit = (() => {}) as typeof processAny.exit
})

afterEach(() => {
  bunAny.serve = originalServe
  bunAny.spawnSync = originalSpawnSync
  globalThis.setInterval = originalSetInterval
  console.log = originalConsoleLog
  console.error = originalConsoleError
  processAny.on = originalProcessOn
  processAny.exit = originalProcessExit
})

describe('GET /api/directories', () => {
  test('returns listing for valid path', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-dir-'))
    try {
      await fs.mkdir(path.join(tempRoot, 'alpha'))
      await fs.writeFile(path.join(tempRoot, 'file.txt'), 'hello')

      const response = await fetchDirectories(tempRoot)
      expect(response.status).toBe(200)
      const payload = (await response.json()) as DirectoryListing
      expect(payload.path).toBe(tempRoot)
      expect(payload.directories.map((entry) => entry.name)).toEqual(['alpha'])
      expect(payload.truncated).toBe(false)
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('expands ~ correctly', async () => {
    const home = process.env.HOME || process.env.USERPROFILE
    if (!home) {
      throw new Error('Expected HOME to be set')
    }

    const response = await fetchDirectories('~')
    expect(response.status).toBe(200)
    const payload = (await response.json()) as DirectoryListing
    expect(payload.path).toBe(path.resolve(home))
  })

  test('returns 404 for missing directory', async () => {
    const missingPath = path.join(os.tmpdir(), 'agentboard-missing-dir')
    const response = await fetchDirectories(missingPath)
    expect(response.status).toBe(404)
    const payload = (await response.json()) as DirectoryErrorResponse
    expect(payload.error).toBe('not_found')
  })

  test('returns 403 for permission denied', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-dir-'))
    const lockedPath = path.join(tempRoot, 'locked')
    await fs.mkdir(lockedPath)
    try {
      await fs.chmod(lockedPath, 0o000)
      const response = await fetchDirectories(lockedPath)
      expect(response.status).toBe(403)
      const payload = (await response.json()) as DirectoryErrorResponse
      expect(payload.error).toBe('forbidden')
    } finally {
      await fs.chmod(lockedPath, 0o700)
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('sorts dot directories first', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-dir-'))
    try {
      await Promise.all([
        fs.mkdir(path.join(tempRoot, '.config')),
        fs.mkdir(path.join(tempRoot, 'alpha')),
        fs.mkdir(path.join(tempRoot, 'Beta')),
      ])

      const response = await fetchDirectories(tempRoot)
      const payload = (await response.json()) as DirectoryListing
      expect(payload.directories.map((entry) => entry.name)).toEqual([
        '.config',
        'alpha',
        'Beta',
      ])
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('truncates at 200 entries', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-dir-'))
    try {
      const dirNames = Array.from({ length: 210 }, (_, i) =>
        `dir-${String(i).padStart(3, '0')}`
      )
      await Promise.all(
        dirNames.map((name) => fs.mkdir(path.join(tempRoot, name)))
      )

      const response = await fetchDirectories(tempRoot)
      const payload = (await response.json()) as DirectoryListing
      expect(payload.directories).toHaveLength(200)
      expect(payload.truncated).toBe(true)
      expect(payload.directories[0]?.name).toBe('dir-000')
      expect(payload.directories[199]?.name).toBe('dir-199')
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true })
    }
  })

  test('rejects paths longer than 4096 characters', async () => {
    const longPath = 'a'.repeat(4097)
    const response = await fetchDirectories(longPath)
    expect(response.status).toBe(400)
    const payload = (await response.json()) as DirectoryErrorResponse
    expect(payload.error).toBe('invalid_path')
  })
})
