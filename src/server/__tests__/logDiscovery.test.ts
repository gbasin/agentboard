import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  encodeProjectPath,
  extractProjectPath,
  extractSessionId,
  isCodexSubagent,
  scanAllLogDirs,
} from '../logDiscovery'

let tempRoot: string
let claudeDir: string
let codexDir: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logs-'))
  claudeDir = path.join(tempRoot, 'claude')
  codexDir = path.join(tempRoot, 'codex')
  process.env.CLAUDE_CONFIG_DIR = claudeDir
  process.env.CODEX_HOME = codexDir
})

afterEach(async () => {
  if (originalClaude) process.env.CLAUDE_CONFIG_DIR = originalClaude
  else delete process.env.CLAUDE_CONFIG_DIR
  if (originalCodex) process.env.CODEX_HOME = originalCodex
  else delete process.env.CODEX_HOME
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
