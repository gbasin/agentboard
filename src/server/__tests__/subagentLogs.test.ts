import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildCodexIndex,
  clearSubagentLogCaches,
  collectCodexDescendants,
  getSubagentLogPaths,
  registerCodexSubagent,
  scanCodexSubagentLinks,
} from '../subagentLogs'
import { getMergedPullRequests } from '../agentSessions'
import { clearPrScanCache } from '../prExtractor'
import type { AgentSessionRecord } from '../db'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-sub-'))
  clearSubagentLogCaches()
  clearPrScanCache()
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

function claudeBashToolUse(command: string, id: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    message: {
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
    },
  })
}

function claudeToolResult(text: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  })
}

function makeRecord(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    id: 1,
    sessionId: 'session-1',
    logFilePath: '',
    projectPath: '',
    slug: null,
    agentType: 'claude',
    displayName: 'x',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-01T00:00:00.000Z',
    lastUserMessage: null,
    currentWindow: null,
    isHibernating: false,
    lastResumeError: null,
    wakeStartedAt: null,
    lastKnownLogSize: null,
    isCodexExec: false,
    launchCommand: null,
    ...overrides,
  }
}

describe('getSubagentLogPaths', () => {
  test('claude: finds agent transcripts under <stem>/subagents', async () => {
    const logPath = path.join(tempRoot, 'sess-1.jsonl')
    const subDir = path.join(tempRoot, 'sess-1', 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    const agentLog = path.join(subDir, 'agent-abc.jsonl')
    await fs.writeFile(agentLog, '{}\n')
    await fs.writeFile(path.join(subDir, 'agent-abc.meta.json'), '{}')
    // tool-results sibling must not be picked up
    await fs.mkdir(path.join(tempRoot, 'sess-1', 'tool-results'))
    await fs.writeFile(
      path.join(tempRoot, 'sess-1', 'tool-results', 'x.jsonl'),
      '{}\n'
    )

    expect(getSubagentLogPaths(logPath, 'claude', 'sess-1')).toEqual([agentLog])
  })

  test('claude: returns [] when no subagents dir exists', () => {
    expect(
      getSubagentLogPaths(path.join(tempRoot, 'nope.jsonl'), 'claude', 'x')
    ).toEqual([])
  })

  test('pi/omp: finds session_init logs in the artifact dir only', async () => {
    const logPath = path.join(tempRoot, 'main.jsonl')
    const artDir = path.join(tempRoot, 'main')
    await fs.mkdir(artDir, { recursive: true })
    const subLog = path.join(artDir, 'task-1.jsonl')
    await fs.writeFile(
      subLog,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'sub-1' }),
        JSON.stringify({ type: 'session_init', id: 'e1', task: 't' }),
      ].join('\n') + '\n'
    )
    // A sibling jsonl without session_init is not a subagent transcript.
    const otherLog = path.join(artDir, 'notes.jsonl')
    await fs.writeFile(otherLog, JSON.stringify({ type: 'session' }) + '\n')
    // Non-jsonl artifacts are ignored by the listing itself.
    await fs.writeFile(path.join(artDir, 'out.md'), 'x')

    expect(getSubagentLogPaths(logPath, 'omp', 'main-1')).toEqual([subLog])
  })

  test('codex: resolves descendants transitively via parent_thread_id', async () => {
    const mk = async (name: string, payload: object) => {
      const p = path.join(tempRoot, name)
      await fs.writeFile(
        p,
        JSON.stringify({ type: 'session_meta', payload }) + '\n'
      )
      return p
    }
    const child = await mk('child.jsonl', {
      id: 'child-1',
      source: { subagent: 'review' },
      parent_thread_id: 'root-1',
    })
    const grandchild = await mk('grandchild.jsonl', {
      id: 'gc-1',
      source: { subagent: { thread_spawn: { parent_thread_id: 'child-1' } } },
    })
    const unrelated = await mk('unrelated.jsonl', {
      id: 'other-1',
      source: { subagent: 'review' },
      parent_thread_id: 'other-root',
    })

    const index = buildCodexIndex([child, grandchild, unrelated])
    expect(collectCodexDescendants(index, 'root-1')).toEqual([
      child,
      grandchild,
    ])
    expect(collectCodexDescendants(index, 'other-root')).toEqual([unrelated])
    expect(collectCodexDescendants(index, 'nothing')).toEqual([])
  })

  test('codex: forked/resumed sessions (string source + forked_from_id) are not indexed', async () => {
    const resumed = path.join(tempRoot, 'resumed.jsonl')
    await fs.writeFile(
      resumed,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'resumed-1', source: 'cli', forked_from_id: 'root-9' },
      }) + '\n'
    )
    const index = buildCodexIndex([resumed])
    expect(index.size).toBe(0)
    expect(collectCodexDescendants(index, 'root-9')).toEqual([])
  })

  test('codex: registerCodexSubagent feeds the live index', async () => {
    const logPath = path.join(tempRoot, 'codex-main.jsonl')
    await fs.writeFile(logPath, '{}\n')
    const subPath = path.join(tempRoot, 'codex-sub.jsonl')
    registerCodexSubagent('sub-1', 'codex-main-id', subPath)
    expect(
      getSubagentLogPaths(logPath, 'codex', 'codex-main-id')
    ).toEqual([subPath])
    // Depth-2 chains resolve through registered nodes too.
    const gcPath = path.join(tempRoot, 'codex-gc.jsonl')
    registerCodexSubagent('gc-1', 'sub-1', gcPath)
    expect(getSubagentLogPaths(logPath, 'codex', 'codex-main-id')).toEqual([
      subPath,
      gcPath,
    ])
  })

  test('codex: scanCodexSubagentLinks rg-filters and parses heads under a root', async () => {
    const dir = path.join(tempRoot, 'codex-sessions')
    await fs.mkdir(dir, { recursive: true })
    const mk = async (name: string, payload: object) => {
      const p = path.join(dir, name)
      await fs.writeFile(
        p,
        JSON.stringify({ type: 'session_meta', payload }) + '\n'
      )
      return p
    }
    const sub = await mk('sub.jsonl', {
      id: 'sub-1',
      source: { subagent: 'review' },
      parent_thread_id: 'root-1',
    })
    // A plain CLI session mentions nothing subagent-related — rg skips it.
    await mk('cli.jsonl', { id: 'cli-1', source: 'cli' })

    expect(scanCodexSubagentLinks(dir)).toEqual([
      { ownId: 'sub-1', parentId: 'root-1', logPath: sub },
    ])
    expect(scanCodexSubagentLinks(path.join(dir, 'missing'))).toEqual([])
  })

  test('devin/grok: no subagent mapping', () => {
    expect(getSubagentLogPaths('/x/y.jsonl', 'devin', 's')).toEqual([])
    expect(getSubagentLogPaths('/x/y.jsonl', 'grok', 's')).toEqual([])
  })
})

describe('getMergedPullRequests', () => {
  test('attributes subagent-created PRs to the parent session', async () => {
    const logPath = path.join(tempRoot, 'sess-9.jsonl')
    // Main log: gh pr create only inside an Agent prompt — not a real create.
    await fs.writeFile(
      logPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_agent',
              name: 'Agent',
              input: { prompt: 'run gh pr create --fill please' },
            },
          ],
        },
      }) + '\n'
    )
    const subDir = path.join(tempRoot, 'sess-9', 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(
      path.join(subDir, 'agent-x.jsonl'),
      [
        claudeBashToolUse('gh pr create --fill', 'toolu_sub1'),
        claudeToolResult('https://github.com/acme/widgets/pull/77', 'toolu_sub1'),
      ].join('\n') + '\n'
    )

    const record = makeRecord({ logFilePath: logPath, sessionId: 'sess-9' })
    expect(getMergedPullRequests(record)).toEqual([
      {
        url: 'https://github.com/acme/widgets/pull/77',
        repo: 'acme/widgets',
        number: 77,
      },
    ])
  })

  test('dedupes PRs found in both main and subagent logs', async () => {
    const logPath = path.join(tempRoot, 'sess-10.jsonl')
    const prUrl = 'https://github.com/acme/widgets/pull/5'
    await fs.writeFile(
      logPath,
      [
        claudeBashToolUse('gh pr create', 'toolu_a'),
        claudeToolResult(prUrl, 'toolu_a'),
      ].join('\n') + '\n'
    )
    const subDir = path.join(tempRoot, 'sess-10', 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(
      path.join(subDir, 'agent-y.jsonl'),
      [
        claudeBashToolUse('gh pr view ' + prUrl, 'toolu_b'),
        claudeToolResult(prUrl, 'toolu_b'),
      ].join('\n') + '\n'
    )

    const record = makeRecord({ logFilePath: logPath, sessionId: 'sess-10' })
    // Note: the subagent command is `gh pr view`, not create — its result URL
    // must not be attributed at all.
    expect(getMergedPullRequests(record)).toEqual([
      { url: prUrl, repo: 'acme/widgets', number: 5 },
    ])
  })
})
