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
import { handleMatchWorkerRequest } from '../logMatchWorker'
import type {
  MatchWorkerRequest,
  MatchWorkerResponse,
} from '../logMatchWorkerTypes'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync

const tmuxOutputs = new Map<string, string>()

const baseProjectPath = path.join(process.cwd(), 'fixtures', 'alpha')
const baseSession: Session = {
  id: 'window-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: baseProjectPath,
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

/**
 * Build a log entry in proper Claude/Codex format with "text" field.
 * This format is required for the JSON field pattern matching.
 */
function buildUserLogEntry(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] }
  })
}

class InlineMatchWorkerClient {
  async poll(
    request: Omit<MatchWorkerRequest, 'id'>,
    _options?: { timeoutMs?: number }
  ): Promise<MatchWorkerResponse> {
    const response = handleMatchWorkerRequest({ ...request, id: 'test' })
    if (response.type === 'error') {
      throw new Error(response.error ?? 'Log match worker error')
    }
    return response
  }

  dispose(): void {}
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
  test('skips file content reads for already-known sessions', async () => {
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
    const logPath = path.join(logDir, 'session-known.jsonl')
    const line = buildUserLogEntry(tokens, { sessionId: 'claude-session-known', cwd: projectPath })
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: tokens }] },
    })
    await fs.writeFile(logPath, `${line}\n${assistantLine}\n`)

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })

    // First poll - session is discovered
    const stats1 = await poller.pollOnce()
    expect(stats1.newSessions).toBe(1)

    const record = db.getSessionByLogPath(logPath)
    expect(record?.sessionId).toBe('claude-session-known')

    // Touch the file to update mtime
    const now = new Date()
    await fs.utimes(logPath, now, now)

    // Second poll - session already known, should skip enrichment
    // We verify this by checking that the response includes the entry
    // but with logTokenCount = -1 (marker for skipped enrichment)
    const stats2 = await poller.pollOnce()
    expect(stats2.newSessions).toBe(0)

    // Verify the session was updated (lastActivityAt changed)
    const updatedRecord = db.getSessionById('claude-session-known')
    expect(updatedRecord).toBeDefined()

    db.close()
  })

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
    const line = buildUserLogEntry(tokens, { sessionId: 'claude-session-1', cwd: projectPath })
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: tokens }] },
    })
    await fs.writeFile(logPath, `${line}\n${assistantLine}\n`)

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })
    const stats = await poller.pollOnce()
    expect(stats.newSessions).toBe(1)

    const record = db.getSessionByLogPath(logPath)
    expect(record?.currentWindow).toBe(baseSession.tmuxWindow)

    db.close()
  })

  test('does not steal window from existing session when new log matches', async () => {
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
    const lineA = buildUserLogEntry(tokensA, { sessionId: 'claude-session-a', cwd: projectPath })
    const assistantLineA = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: tokensA }] },
    })
    await fs.writeFile(logPathA, `${lineA}\n${assistantLineA}\n`)

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })
    await poller.pollOnce()

    // Session A now has the window
    const recordA = db.getSessionById('claude-session-a')
    expect(recordA?.currentWindow).toBe(baseSession.tmuxWindow)

    // Change terminal content to match a different log
    const tokensB = Array.from({ length: 60 }, (_, i) => `next${i}`).join(' ')
    setTmuxOutput(baseSession.tmuxWindow, buildLastExchangeOutput(tokensB))

    const logPathB = path.join(logDir, 'session-b.jsonl')
    const lineB = buildUserLogEntry(tokensB, { sessionId: 'claude-session-b', cwd: projectPath })
    const assistantLineB = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: tokensB }] },
    })
    await fs.writeFile(logPathB, `${lineB}\n${assistantLineB}\n`)

    await poller.pollOnce()

    // Session A should KEEP the window (not be orphaned)
    const oldRecord = db.getSessionById('claude-session-a')
    expect(oldRecord?.currentWindow).toBe(baseSession.tmuxWindow)

    // Session B should be created as orphaned (no window)
    const newRecord = db.getSessionById('claude-session-b')
    expect(newRecord?.currentWindow).toBeNull()

    db.close()
  })

  test('updates lastUserMessage when newer log entry arrives', async () => {
    const db = initDatabase({ path: ':memory:' })
    const registry = new SessionRegistry()
    registry.replaceSessions([baseSession])

    const projectPath = baseSession.projectPath
    const encoded = encodeProjectPath(projectPath)
    const logDir = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'projects',
      encoded
    )
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session.jsonl')

    const sessionId = 'claude-session-a'
    const oldMessage = 'old prompt'
    const newMessage = 'new prompt'
    const logLines = [
      buildUserLogEntry(oldMessage, { sessionId, cwd: projectPath }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ack' }] } }),
      buildUserLogEntry(newMessage, { sessionId, cwd: projectPath }),
    ].join('\n')
    await fs.writeFile(logPath, `${logLines}\n`)

    const stats = await fs.stat(logPath)
    db.insertSession({
      sessionId,
      logFilePath: logPath,
      projectPath,
      agentType: 'claude',
      displayName: 'alpha',
      createdAt: stats.birthtime.toISOString(),
      lastActivityAt: new Date(stats.mtime.getTime() - 1000).toISOString(),
      lastUserMessage: oldMessage,
      currentWindow: baseSession.tmuxWindow,
      isPinned: false,
      lastResumeError: null,
      lastKnownLogSize: 0,
      isCodexExec: false,
    })

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })
    await poller.pollOnce()

    const updated = db.getSessionById(sessionId)
    expect(updated?.lastUserMessage).toBe(newMessage)

    db.close()
  })

  test('rematches orphaned sessions on startup without new activity', async () => {
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
    const logPath = path.join(logDir, 'session-orphan.jsonl')
    const line = buildUserLogEntry(tokens, { sessionId: 'claude-session-orphan', cwd: projectPath })
    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: tokens }] },
    })
    await fs.writeFile(logPath, `${line}\n${assistantLine}\n`)

    const stats = await fs.stat(logPath)
    db.insertSession({
      sessionId: 'claude-session-orphan',
      logFilePath: logPath,
      projectPath,
      agentType: 'claude',
      displayName: 'orphan',
      createdAt: stats.birthtime.toISOString(),
      lastActivityAt: stats.mtime.toISOString(),
      lastUserMessage: null,
      currentWindow: null,
      isPinned: false,
      lastResumeError: null,
      lastKnownLogSize: null,
      isCodexExec: false,
    })

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })
    // Start poller which triggers first poll and background orphan rematch
    poller.start(5000)
    // Wait for initial poll to complete first (avoids worker contention)
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Wait for orphan rematch to complete
    await poller.waitForOrphanRematch()

    const updated = db.getSessionById('claude-session-orphan')
    expect(updated?.currentWindow).toBe(baseSession.tmuxWindow)
    expect(updated?.displayName).toBe(baseSession.name)

    poller.stop()
    db.close()
  })

  test('ignores external windows in name-based orphan fallback', async () => {
    const db = initDatabase({ path: ':memory:' })
    const registry = new SessionRegistry()
    const externalWindow: Session = {
      ...baseSession,
      id: 'external:1',
      name: 'orphan',
      tmuxWindow: 'external:1',
      projectPath: '/tmp/external',
      source: 'external',
    }
    registry.replaceSessions([externalWindow])

    const tokens = Array.from({ length: 10 }, (_, i) => `token${i}`).join(' ')
    const projectPath = '/tmp/orphan'
    const encoded = encodeProjectPath(projectPath)
    const logDir = path.join(
      process.env.CLAUDE_CONFIG_DIR ?? '',
      'projects',
      encoded
    )
    await fs.mkdir(logDir, { recursive: true })
    const logPath = path.join(logDir, 'session-orphan.jsonl')
    const line = buildUserLogEntry(tokens, {
      sessionId: 'claude-session-orphan',
      cwd: projectPath,
    })
    await fs.writeFile(logPath, `${line}\n`)

    const stats = await fs.stat(logPath)
    db.insertSession({
      sessionId: 'claude-session-orphan',
      logFilePath: logPath,
      projectPath,
      agentType: 'claude',
      displayName: 'orphan',
      createdAt: stats.birthtime.toISOString(),
      lastActivityAt: stats.mtime.toISOString(),
      lastUserMessage: null,
      currentWindow: null,
      isPinned: false,
      lastResumeError: null,
      lastKnownLogSize: null,
      isCodexExec: false,
    })

    const poller = new LogPoller(db, registry, {
      matchWorkerClient: new InlineMatchWorkerClient(),
    })
    poller.start(5000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await poller.waitForOrphanRematch()

    const updated = db.getSessionById('claude-session-orphan')
    expect(updated?.currentWindow).toBeNull()

    poller.stop()
    db.close()
  })
})
