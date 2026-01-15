import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { LogPoller } from '../logPoller'
import { SessionRegistry } from '../SessionRegistry'
import type { Session } from '../../shared/types'
import { encodeProjectPath } from '../logDiscovery'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync

const tmuxOutputs = new Map<string, string>()

const baseSession: Session = {
  id: 'window-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'waiting',
  lastActivity: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  source: 'managed',
}

let tempRoot: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME

function setTmuxOutput(target: string, content: string) {
  tmuxOutputs.set(target, content)
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
        output.push(
          JSON.stringify({ type: 'match', data: { line_number: index + 1 } })
        )
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
      if (arg === '--glob') {
        skipNext = true
        continue
      }
      if (arg === '--threads') {
        skipNext = true
        continue
      }
      if (arg.startsWith('-')) {
        continue
      }
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

function buildLastExchangeOutput(tokens: string): string {
  return `❯ previous\n⏺ ${tokens}\n❯ ${tokens}\n`
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-poller-'))
  process.env.CLAUDE_CONFIG_DIR = path.join(tempRoot, 'claude')
  process.env.CODEX_HOME = path.join(tempRoot, 'codex')

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
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('LogPoller', () => {
  test('detects new sessions and matches windows', async () => {
    const db = initDatabase({ path: ':memory:' })
    const registry = new SessionRegistry()
    registry.replaceSessions([baseSession])

    const tokens = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ')
    setTmuxOutput(baseSession.tmuxWindow, buildLastExchangeOutput(tokens))

    const projectPath = baseSession.projectPath
    const encoded = encodeProjectPath(projectPath)
    const logDir = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'projects',
      encoded
    )
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-1.jsonl')
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-1',
      cwd: projectPath,
      content: tokens,
    })
    const assistantLine = JSON.stringify({
      type: 'assistant',
      content: tokens,
    })
    await fs.writeFile(logPath, `${line}\n${assistantLine}\n`)

    const poller = new LogPoller(db, registry, { matchWorker: false })
    const stats = await poller.pollOnce()
    expect(stats.newSessions).toBe(1)

    const record = db.getSessionByLogPath(logPath)
    expect(record?.currentWindow).toBe(baseSession.tmuxWindow)

    db.close()
  })

  test('orphans previous session when new log matches same window', async () => {
    const db = initDatabase({ path: ':memory:' })
    const registry = new SessionRegistry()
    registry.replaceSessions([baseSession])

    const tokensA = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ')
    setTmuxOutput(baseSession.tmuxWindow, buildLastExchangeOutput(tokensA))

    const projectPath = baseSession.projectPath
    const encoded = encodeProjectPath(projectPath)
    const logDir = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'projects',
      encoded
    )
    await fs.mkdir(logDir, { recursive: true })

    const logPathA = path.join(logDir, 'session-a.jsonl')
    const lineA = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-a',
      cwd: projectPath,
      content: tokensA,
    })
    const assistantLineA = JSON.stringify({
      type: 'assistant',
      content: tokensA,
    })
    await fs.writeFile(logPathA, `${lineA}\n${assistantLineA}\n`)

    const poller = new LogPoller(db, registry, { matchWorker: false })
    await poller.pollOnce()

    const tokensB = Array.from({ length: 60 }, (_, i) => `next${i}`).join(' ')
    setTmuxOutput(baseSession.tmuxWindow, buildLastExchangeOutput(tokensB))

    const logPathB = path.join(logDir, 'session-b.jsonl')
    const lineB = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-b',
      cwd: projectPath,
      content: tokensB,
    })
    const assistantLineB = JSON.stringify({
      type: 'assistant',
      content: tokensB,
    })
    await fs.writeFile(logPathB, `${lineB}\n${assistantLineB}\n`)

    await poller.pollOnce()

    const oldRecord = db.getSessionById('claude-session-a')
    const newRecord = db.getSessionById('claude-session-b')

    expect(oldRecord?.currentWindow).toBeNull()
    expect(newRecord?.currentWindow).toBe(baseSession.tmuxWindow)

    db.close()
  })
})
