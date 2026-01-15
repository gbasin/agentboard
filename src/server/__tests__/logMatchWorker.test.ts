import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Session } from '../../shared/types'

const messages: unknown[] = []
const ctx = {
  postMessage: (message: unknown) => {
    messages.push(message)
  },
} as DedicatedWorkerGlobalScope

const globalAny = globalThis as unknown as {
  self?: DedicatedWorkerGlobalScope | undefined
}

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync
const tmuxOutputs = new Map<string, string>()

const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME

let tempRoot = ''

function buildPromptScrollback(
  messages: string[],
  options: { prefix?: string; glyph?: string } = {}
): string {
  const prefix = options.prefix ?? ''
  const glyph = options.glyph ?? '❯'
  return messages
    .map((message) => `${prefix}${glyph} ${message}\n⏺ ok`)
    .join('\n')
    .concat('\n')
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = []
  if (!fsSync.existsSync(dir)) return results
  const entries = fsSync.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath)
    }
  }
  return results
}

function runRg(args: string[]) {
  const patternIndex = args.indexOf('-e')
  const pattern = patternIndex >= 0 ? args[patternIndex + 1] ?? '' : ''
  const regex = pattern ? new RegExp(pattern, 'm') : null

  if (args.includes('--json')) {
    const filePath = args[args.length - 1] ?? ''
    if (!filePath || !regex || !fsSync.existsSync(filePath)) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const lines = fsSync.readFileSync(filePath, 'utf8').split('\n')
    const output: string[] = []
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        output.push(JSON.stringify({ type: 'match', data: { line_number: index + 1 } }))
      }
    })
    const exitCode = output.length > 0 ? 0 : 1
    return {
      exitCode,
      stdout: Buffer.from(output.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  if (args.includes('-l')) {
    if (!regex) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const targets: string[] = []
    let skipNext = false
    for (let i = patternIndex + 2; i < args.length; i += 1) {
      const arg = args[i] ?? ''
      if (skipNext) {
        skipNext = false
        continue
      }
      if (!arg) continue
      if (arg === '--glob' || arg === '--threads') {
        skipNext = true
        continue
      }
      if (arg.startsWith('-')) continue
      targets.push(arg)
    }
    const files: string[] = []
    for (const target of targets) {
      if (!fsSync.existsSync(target)) continue
      const stat = fsSync.statSync(target)
      if (stat.isDirectory()) {
        files.push(...findJsonlFiles(target))
      } else if (stat.isFile()) {
        files.push(target)
      }
    }
    const matches = files.filter((file) => {
      const content = fsSync.readFileSync(file, 'utf8')
      return regex.test(content)
    })
    return {
      exitCode: matches.length > 0 ? 0 : 1,
      stdout: Buffer.from(matches.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
}

function setTmuxOutput(target: string, content: string) {
  tmuxOutputs.set(target, content)
}

beforeAll(async () => {
  globalAny.self = ctx
  await import('../logMatchWorker')
})

afterAll(() => {
  if (globalAny.self === ctx) {
    globalAny.self = undefined
  }
  bunAny.spawnSync = originalSpawnSync
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
})

beforeEach(async () => {
  messages.length = 0
  tmuxOutputs.clear()

  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-worker-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'claude')
  process.env.CODEX_HOME = path.join(tempRoot, 'codex')
  await fs.mkdir(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), {
    recursive: true,
  })
  await fs.mkdir(path.join(process.env.CODEX_HOME, 'sessions'), {
    recursive: true,
  })

  bunAny.spawnSync = ((args: string[]) => {
    if (args[0] === 'tmux' && args[1] === 'capture-pane') {
      const targetIndex = args.indexOf('-t')
      const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
      const output = tmuxOutputs.get(target ?? '') ?? ''
      return {
        exitCode: 0,
        stdout: Buffer.from(output),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    if (args[0] === 'rg') {
      return runRg(args) as ReturnType<typeof Bun.spawnSync>
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync
})

afterEach(async () => {
  bunAny.spawnSync = originalSpawnSync
  tmuxOutputs.clear()
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
})

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  agentType: 'claude',
  source: 'managed',
}

describe('logMatchWorker', () => {
  test('skips matching when sessions already mapped', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-1.jsonl')
    await fs.writeFile(
      logPath,
      JSON.stringify({ sessionId: 'session-1', cwd: '/tmp/alpha', type: 'user', content: 'hello' })
    )

    ctx.onmessage?.({
      data: {
        id: 'request-1',
        windows: [baseSession],
        maxLogsPerPoll: 5,
        sessions: [
          {
            sessionId: 'session-1',
            logFilePath: logPath,
            currentWindow: 'agentboard:1',
            lastActivityAt: new Date().toISOString(),
          },
        ],
        scrollbackLines: 25,
      },
    } as MessageEvent)

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    expect(response.matchSkipped).toBe(true)
    expect(response.matches).toEqual([])
    expect(response.matchWindowCount).toBe(0)
    expect(response.matchLogCount).toBe(0)
  })

  test('matches entries and returns resolved windows', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-2.jsonl')
    const message = 'alpha one'
    await fs.writeFile(
      logPath,
      JSON.stringify({ sessionId: 'session-2', cwd: '/tmp/alpha', type: 'user', content: message })
    )

    setTmuxOutput('agentboard:1', buildPromptScrollback([message]))

    ctx.onmessage?.({
      data: {
        id: 'request-2',
        windows: [baseSession],
        maxLogsPerPoll: 5,
        sessions: [],
        scrollbackLines: 25,
      },
    } as MessageEvent)

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('result')
    expect(response.matchSkipped).toBe(false)
    expect(response.matchWindowCount).toBe(1)
    expect(response.matchLogCount).toBe(1)
    expect(response.matches).toEqual([{ logPath, tmuxWindow: 'agentboard:1' }])
  })

  test('returns error responses when matching throws', async () => {
    const logDir = path.join(process.env.CLAUDE_CONFIG_DIR as string, 'projects', 'alpha')
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-3.jsonl')
    await fs.writeFile(
      logPath,
      JSON.stringify({ sessionId: 'session-3', cwd: '/tmp/alpha', type: 'user', content: 'boom' })
    )

    bunAny.spawnSync = (() => {
      throw new Error('boom')
    }) as typeof Bun.spawnSync

    ctx.onmessage?.({
      data: {
        id: 'request-3',
        windows: [baseSession],
        maxLogsPerPoll: 5,
        sessions: [],
        scrollbackLines: 25,
      },
    } as MessageEvent)

    expect(messages).toHaveLength(1)
    const response = messages[0] as Record<string, unknown>
    expect(response.type).toBe('error')
    expect(response.error).toBe('boom')
  })
})
