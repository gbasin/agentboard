import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { collectLogEntryBatch } from '../logPollData'

let tempRoot: string
let claudeDir: string
let codexDir: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME

async function writeJsonl(filePath: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, lines.join('\n'))
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logpolldata-'))
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

describe('collectLogEntryBatch', () => {
  test('sorts logs and enriches snapshots', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-a',
      'session-a.jsonl'
    )
    const codexLog = path.join(codexDir, 'sessions', '2026', '01', '10', 'a.jsonl')
    const subagentLog = path.join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '11',
      'subagent.jsonl'
    )

    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-a',
        cwd: '/project/a',
        content: 'hello world',
      }),
    ])
    await writeJsonl(codexLog, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-b', cwd: '/project/b', source: 'cli' },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: 'hello from codex',
        },
      }),
    ])
    await writeJsonl(subagentLog, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-c', cwd: '/project/c', source: { subagent: 'review' } },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: 'subagent content',
        },
      }),
    ])

    await fs.utimes(claudeLog, new Date(1_000), new Date(3_000))
    await fs.utimes(codexLog, new Date(1_000), new Date(2_000))
    await fs.utimes(subagentLog, new Date(1_000), new Date(1_000))

    const result = collectLogEntryBatch(3)
    expect(result.entries).toHaveLength(3)
    expect(result.entries[0]?.logPath).toBe(claudeLog)
    expect(result.entries[1]?.logPath).toBe(codexLog)
    expect(result.entries[2]?.logPath).toBe(subagentLog)
    expect(result.entries[0]?.logTokenCount).toBe(2)
    expect(result.entries[1]?.logTokenCount).toBeGreaterThan(0)
    expect(result.entries[2]?.logTokenCount).toBe(0)
    expect(result.entries[2]?.isCodexSubagent).toBe(true)
    expect(result.entries[0]?.agentType).toBe('claude')
    expect(result.entries[1]?.agentType).toBe('codex')
    expect(result.entries[0]?.projectPath).toBe('/project/a')
  })

  test('clamps maxLogs to at least one entry', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-a',
      'session-a.jsonl'
    )
    const codexLog = path.join(codexDir, 'sessions', '2026', '01', '10', 'a.jsonl')

    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-a',
        cwd: '/project/a',
        content: 'hello world',
      }),
    ])
    await writeJsonl(codexLog, [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-b', cwd: '/project/b', source: 'cli' },
      }),
    ])

    await fs.utimes(claudeLog, new Date(1_000), new Date(5_000))
    await fs.utimes(codexLog, new Date(1_000), new Date(4_000))

    const result = collectLogEntryBatch(0)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.logPath).toBe(claudeLog)
  })
})
