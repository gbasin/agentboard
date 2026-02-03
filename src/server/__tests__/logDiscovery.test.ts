import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  encodeProjectPath,
  extractProjectPath,
  extractSessionId,
  getLogSearchDirs,
  isCodexExec,
  isCodexSubagent,
  scanAllLogDirs,
} from '../logDiscovery'

let tempRoot: string
let claudeDir: string
let codexDir: string
let piDir: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME
const originalPi = process.env.PI_HOME

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logs-'))
  claudeDir = path.join(tempRoot, 'claude')
  codexDir = path.join(tempRoot, 'codex')
  piDir = path.join(tempRoot, 'pi')
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = codexDir
  process.env.PI_HOME = piDir
})

afterEach(async () => {
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
  if (originalPi) process.env.PI_HOME = originalPi
  else delete process.env.PI_HOME
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test('encodeProjectPath matches Claude path convention', () => {
  const encoded = encodeProjectPath('/Users/example/project')
  expect(encoded).toBe('-Users-example-project')
})

describe('log discovery', () => {
  test('scans Claude and Codex roots for jsonl files', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    await fs.mkdir(claudeProjectDir, { recursive: true })
    const claudeLog = path.join(claudeProjectDir, 'session-1.jsonl')
    await fs.writeFile(claudeLog, '{}\n')

    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const codexLog = path.join(codexLogDir, 'session-2.jsonl')
    await fs.writeFile(codexLog, '{}\n')

    const found = scanAllLogDirs()
    expect(found).toContain(claudeLog)
    expect(found).toContain(codexLog)
  })

  test('skips Claude subagent logs', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    const subagentDir = path.join(claudeProjectDir, 'subagents')
    await fs.mkdir(subagentDir, { recursive: true })
    const subagentLog = path.join(subagentDir, 'agent-1.jsonl')
    await fs.writeFile(subagentLog, '{}\n')

    const found = scanAllLogDirs()
    expect(found).not.toContain(subagentLog)
  })

  test('extracts sessionId and projectPath from Claude logs', async () => {
    const projectPath = '/Users/example/project'
    const encoded = encodeProjectPath(projectPath)
    const claudeProjectDir = path.join(claudeDir, 'projects', encoded)
    await fs.mkdir(claudeProjectDir, { recursive: true })
    const logPath = path.join(claudeProjectDir, 'session-claude.jsonl')
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'claude-session-123',
      cwd: projectPath,
      content: 'hello',
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractSessionId(logPath)).toBe('claude-session-123')
    expect(extractProjectPath(logPath)).toBe(projectPath)
  })

  test('extracts sessionId and projectPath from Codex logs', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'session-codex.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'codex-session-456',
        cwd: '/Users/example/codex-project',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractSessionId(logPath)).toBe('codex-session-456')
    expect(extractProjectPath(logPath)).toBe('/Users/example/codex-project')
  })

  test('expands tilde overrides for log roots', () => {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    if (!home) {
      return
    }

    process.env.CLAUDE_CONFIG_DIR = '~/claude-config'
    process.env.CODEX_HOME = '~/codex-config/'
    const [claudeRoot, codexRoot] = getLogSearchDirs()

    expect(claudeRoot).toBe(path.join(home, 'claude-config', 'projects'))
    expect(codexRoot).toBe(path.join(home, 'codex-config', 'sessions'))
  })

  test('normalizes Windows project paths from logs', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'session-win.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'codex-session-win',
        cwd: 'C:\\Users\\Example\\project\\',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(extractProjectPath(logPath)).toBe('c:/Users/Example/project')
  })
})

describe('isCodexSubagent', () => {
  test('returns false for CLI sessions (source is string)', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'cli-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'cli-session-123',
        cwd: '/Users/example/project',
        source: 'cli',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(false)
  })

  test('returns true for subagent sessions (source is object)', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'subagent-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'subagent-session-456',
        cwd: '/Users/example/project',
        source: { subagent: 'review' },
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(true)
  })

  test('returns false for non-existent files', () => {
    expect(isCodexSubagent('/nonexistent/path.jsonl')).toBe(false)
  })

  test('returns false for empty files', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'empty.jsonl')
    await fs.writeFile(logPath, '')

    expect(isCodexSubagent(logPath)).toBe(false)
  })

  test('returns false for non-session_meta first line', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'other.jsonl')
    const line = JSON.stringify({
      type: 'response_item',
      payload: { role: 'user' },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexSubagent(logPath)).toBe(false)
  })
})

describe('isCodexExec', () => {
  test('returns false for CLI sessions (source is "cli")', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'cli-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'cli-session-123',
        cwd: '/Users/example/project',
        source: 'cli',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(false)
  })

  test('returns true for exec sessions (source is "exec")', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'exec-session.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'exec-session-456',
        cwd: '/private/var/folders/tmp',
        source: 'exec',
        originator: 'codex_exec',
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(true)
  })

  test('returns false for subagent sessions', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'subagent.jsonl')
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'subagent-789',
        cwd: '/Users/example/project',
        source: { subagent: 'review' },
      },
    })
    await fs.writeFile(logPath, `${line}\n`)

    expect(isCodexExec(logPath)).toBe(false)
  })

  test('returns false for non-existent files', () => {
    expect(isCodexExec('/nonexistent/path.jsonl')).toBe(false)
  })

  test('returns false for empty files', async () => {
    const codexLogDir = path.join(codexDir, 'sessions', '2026', '01', '10')
    await fs.mkdir(codexLogDir, { recursive: true })
    const logPath = path.join(codexLogDir, 'empty-exec.jsonl')
    await fs.writeFile(logPath, '')

    expect(isCodexExec(logPath)).toBe(false)
  })
})
