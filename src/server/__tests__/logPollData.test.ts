import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  collectLogEntriesForPaths,
  collectLogEntryBatch,
  enrichLogEntry,
} from '../logPollData'

let tempRoot: string
let claudeDir: string
let codexDir: string
let piDir: string
const originalClaude = process.env.CLAUDE_CONFIG_DIR
const originalCodex = process.env.CODEX_HOME
const originalPi = process.env.PI_HOME

async function writeJsonl(filePath: string, lines: string[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, lines.join('\n'))
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logpolldata-'))
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

  test('skips enrichment for known sessions and sets logTokenCount to -1', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-known',
      'session-known.jsonl'
    )

    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-known-id',
        cwd: '/project/known',
        content: 'hello world with many tokens for counting',
      }),
    ])

    // First call without known sessions - should read file and count tokens
    const result1 = collectLogEntryBatch(10)
    expect(result1.entries).toHaveLength(1)
    expect(result1.entries[0]?.sessionId).toBe('session-known-id')
    expect(result1.entries[0]?.projectPath).toBe('/project/known')
    expect(result1.entries[0]?.logTokenCount).toBeGreaterThan(0)

    const actualTokenCount = result1.entries[0]?.logTokenCount ?? 0

    // Second call with known session - should skip enrichment
    const result2 = collectLogEntryBatch(10, {
      knownSessions: [
        {
          logFilePath: claudeLog,
          sessionId: 'session-known-id',
          projectPath: '/project/known',
          agentType: 'claude',
          isCodexExec: false,
        },
      ],
    })

    expect(result2.entries).toHaveLength(1)
    // Should use cached values from knownSessions
    expect(result2.entries[0]?.sessionId).toBe('session-known-id')
    expect(result2.entries[0]?.projectPath).toBe('/project/known')
    expect(result2.entries[0]?.agentType).toBe('claude')
    // logTokenCount = -1 indicates enrichment was skipped
    expect(result2.entries[0]?.logTokenCount).toBe(-1)

    // Verify that actual token count would have been positive
    expect(actualTokenCount).toBeGreaterThan(0)
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

describe('enrichLogEntry', () => {
  test('uses known session metadata and skips token counting', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-known',
      'session-known.jsonl'
    )
    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'known-session-id',
        cwd: '/project/known',
        content: 'some content',
      }),
    ])

    const stat = await fs.stat(claudeLog)
    const knownByPath = new Map([
      [
        claudeLog,
        {
          logFilePath: claudeLog,
          sessionId: 'known-session-id',
          projectPath: '/project/known',
          agentType: 'claude' as const,
          isCodexExec: false,
        },
      ],
    ])

    const entry = enrichLogEntry(
      claudeLog,
      stat.mtime.getTime(),
      stat.birthtime.getTime(),
      stat.size,
      knownByPath
    )

    expect(entry.sessionId).toBe('known-session-id')
    expect(entry.projectPath).toBe('/project/known')
    expect(entry.agentType).toBe('claude')
    expect(entry.logTokenCount).toBe(-1)
  })

  test('enriches unknown session metadata from the log file', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-unknown',
      'session-unknown.jsonl'
    )
    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'unknown-session-id',
        cwd: '/project/unknown',
        content: 'hello from unknown session',
      }),
    ])

    const stat = await fs.stat(claudeLog)
    const entry = enrichLogEntry(
      claudeLog,
      stat.mtime.getTime(),
      stat.birthtime.getTime(),
      stat.size,
      new Map()
    )

    expect(entry.sessionId).toBe('unknown-session-id')
    expect(entry.projectPath).toBe('/project/unknown')
    expect(entry.agentType).toBe('claude')
    expect(entry.isCodexSubagent).toBe(false)
    expect(entry.isCodexExec).toBe(false)
    expect(entry.logTokenCount).toBeGreaterThan(0)
  })

  test('detects codex subagent and exec sessions', async () => {
    const subagentLog = path.join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '11',
      'subagent.jsonl'
    )
    const execLog = path.join(
      codexDir,
      'sessions',
      '2026',
      '01',
      '11',
      'exec.jsonl'
    )

    await writeJsonl(subagentLog, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-subagent-id',
          cwd: '/project/subagent',
          source: { subagent: 'review' },
        },
      }),
    ])
    await writeJsonl(execLog, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-exec-id',
          cwd: '/private/var/folders/tmp',
          source: 'exec',
          originator: 'codex_exec',
        },
      }),
    ])

    const subagentStat = await fs.stat(subagentLog)
    const execStat = await fs.stat(execLog)

    const subagentEntry = enrichLogEntry(
      subagentLog,
      subagentStat.mtime.getTime(),
      subagentStat.birthtime.getTime(),
      subagentStat.size,
      new Map()
    )
    const execEntry = enrichLogEntry(
      execLog,
      execStat.mtime.getTime(),
      execStat.birthtime.getTime(),
      execStat.size,
      new Map()
    )

    expect(subagentEntry.isCodexSubagent).toBe(true)
    expect(subagentEntry.isCodexExec).toBe(false)
    expect(execEntry.isCodexSubagent).toBe(false)
    expect(execEntry.isCodexExec).toBe(true)
  })
})

describe('collectLogEntriesForPaths', () => {
  test('builds entries from provided paths and skips deleted files', async () => {
    const claudeLog = path.join(
      claudeDir,
      'projects',
      'project-batch',
      'session-batch.jsonl'
    )
    const deletedLog = path.join(
      claudeDir,
      'projects',
      'project-batch',
      'deleted.jsonl'
    )

    await writeJsonl(claudeLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'batch-session-id',
        cwd: '/project/batch',
        content: 'batch content',
      }),
    ])
    await writeJsonl(deletedLog, [
      JSON.stringify({
        type: 'user',
        sessionId: 'deleted-session-id',
        cwd: '/project/deleted',
        content: 'to be deleted',
      }),
    ])
    await fs.rm(deletedLog, { force: true })

    const entries = collectLogEntriesForPaths([claudeLog, deletedLog])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.logPath).toBe(claudeLog)
    expect(entries[0]?.sessionId).toBe('batch-session-id')
  })
})
