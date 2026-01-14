import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
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
    setTmuxOutput(baseSession.tmuxWindow, tokens)

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
    await fs.writeFile(logPath, `${line}\n`)

    const poller = new LogPoller(db, registry)
    const stats = poller.pollOnce()
    expect(stats.newSessions).toBe(1)

    const record = db.getSessionByLogPath(logPath)
    expect(record?.currentWindow).toBe(baseSession.tmuxWindow)

    db.close()
  })

  test('orphans previous session when new log matches same window', async () => {
    const db = initDatabase({ path: ':memory:' })
    const registry = new SessionRegistry()
    registry.replaceSessions([baseSession])

    const tokens = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ')
    setTmuxOutput(baseSession.tmuxWindow, tokens)

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
      content: tokens,
    })
    await fs.writeFile(logPathA, `${lineA}\n`)

    const poller = new LogPoller(db, registry)
    poller.pollOnce()

    const logPathB = path.join(logDir, 'session-b.jsonl')
    const lineB = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-b',
      cwd: projectPath,
      content: tokens,
    })
    await fs.writeFile(logPathB, `${lineB}\n`)

    poller.pollOnce()

    const oldRecord = db.getSessionById('claude-session-a')
    const newRecord = db.getSessionById('claude-session-b')

    expect(oldRecord?.currentWindow).toBeNull()
    expect(newRecord?.currentWindow).toBe(baseSession.tmuxWindow)

    db.close()
  })
})
