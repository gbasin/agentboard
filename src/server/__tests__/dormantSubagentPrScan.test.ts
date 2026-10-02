import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { toAgentSession } from '../agentSessions'
import { createDormantPrScanner } from '../dormantPrScan'
import type { AgentSessionRecord } from '../db'
import { clearPrScanCache } from '../prExtractor'
import {
  clearSubagentLogCaches,
  registerCodexSubagent,
  setCodexSubagentIndex,
  setCodexSubagentIndexListener,
} from '../subagentLogs'

const realOpen = fs.openSync.bind(fs) as (...args: unknown[]) => number
let tempRoot: string
let counter = 0

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentboard-dormant-sub-'))
  clearPrScanCache()
  clearSubagentLogCaches()
})

afterEach(async () => {
  setCodexSubagentIndexListener(null)
  await fsp.rm(tempRoot, { recursive: true, force: true })
})

function prLines(n: number): string {
  return [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: `t${n}`, name: 'Bash', input: { command: 'gh pr create --fill' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: `t${n}`, content: `https://github.com/a/b/pull/${n}` },
        ],
      },
    }),
  ].join('\n') + '\n'
}

async function makeRecord(
  agentType: 'claude' | 'codex'
): Promise<AgentSessionRecord> {
  const n = ++counter
  const logFilePath = path.join(tempRoot, `main-${n}.jsonl`)
  await fsp.writeFile(logFilePath, '{"type":"user"}\n')
  return {
    id: n,
    sessionId: `parent-${n}`,
    logFilePath,
    projectPath: '/p',
    slug: null,
    agentType,
    displayName: 'x',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-02T00:00:00.000Z',
    lastUserMessage: null,
    currentWindow: null,
    isHibernating: true,
    lastResumeError: null,
    wakeStartedAt: null,
    lastKnownLogSize: fs.statSync(logFilePath).size,
    isCodexExec: false,
    launchCommand: null,
  }
}

async function writeLog(name: string, content: string): Promise<string> {
  const logPath = path.join(tempRoot, name)
  await fsp.mkdir(path.dirname(logPath), { recursive: true })
  await fsp.writeFile(logPath, content)
  return logPath
}

const cachedUrls = (record: AgentSessionRecord) =>
  (toAgentSession(record, { cachedPrsOnly: true }).prs ?? []).map((pr) => pr.url)

describe('dormant PR scan of subagent logs', () => {
  test('a codex subagent index that arrives after the first scan queues a rescan', async () => {
    const parent = await makeRecord('codex')
    const childLog = await writeLog('child.jsonl', prLines(41))
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, { gapMs: 1, notifyMs: 0 })
    setCodexSubagentIndexListener(() => scanner.queue([parent]))

    scanner.queue([parent])
    await Bun.sleep(30)
    expect(cachedUrls(parent)).toEqual([])

    // The index lands later (first full poll); the parent's main log is unchanged.
    setCodexSubagentIndex([
      { ownId: 'child', parentId: parent.sessionId, logPath: childLog },
    ])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    expect(cachedUrls(parent)).toEqual(['https://github.com/a/b/pull/41'])
    scanner.stop()
  })

  test('re-queue rescans a dormant row whose subagent log grew', async () => {
    const parent = await makeRecord('claude')
    const stem = parent.logFilePath.slice(0, -'.jsonl'.length)
    const subLog = await writeLog(
      path.relative(tempRoot, path.join(stem, 'subagents', 'agent-a.jsonl')),
      '{"type":"user"}\n'
    )
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, { gapMs: 1, notifyMs: 0 })
    scanner.queue([parent])
    await Bun.sleep(30)
    expect(cachedUrls(parent)).toEqual([])

    // Only the subagent log changes; the parent's lastKnownLogSize does not.
    await fsp.appendFile(subLog, prLines(42))
    scanner.queue([parent])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    expect(cachedUrls(parent)).toEqual(['https://github.com/a/b/pull/42'])

    // Unchanged on re-queue: nothing is read again.
    const opens = spyOn(fs, 'openSync')
    try {
      scanner.queue([parent])
      await Bun.sleep(30)
      expect(opens).not.toHaveBeenCalled()
    } finally {
      opens.mockRestore()
    }
    scanner.stop()
  })

  test("a session's subagent logs are read in separate slices", async () => {
    const parent = await makeRecord('codex')
    const children = [
      await writeLog('c1.jsonl', prLines(51)),
      await writeLog('c2.jsonl', prLines(52)),
      await writeLog('c3.jsonl', prLines(53)),
    ]
    setCodexSubagentIndex(
      children.map((logPath, i) => ({ ownId: `c${i}`, parentId: parent.sessionId, logPath }))
    )
    const ours = new Set([parent.logFilePath, ...children])
    const events: string[] = []
    const opens = spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      ...rest: unknown[]
    ) => {
      if (ours.has(String(file))) events.push('read')
      return realOpen(file, ...rest)
    }) as typeof fs.openSync)
    // A timer that fires between slices marks the slice boundaries.
    const marker = setInterval(() => events.push('|'), 0)
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, {
      budgetMs: 0,
      gapMs: 2,
      notifyMs: 0,
    })
    try {
      scanner.queue([parent])
      await Bun.sleep(80)
    } finally {
      clearInterval(marker)
      opens.mockRestore()
      scanner.stop()
    }
    const reads = events.join('').replace(/\|+/g, '|').split('|').map((slice) => slice.length / 'read'.length)
    expect(reads.reduce((a, b) => a + b, 0)).toBe(4)
    // Never more than one log per slice at a zero budget.
    expect(Math.max(...reads)).toBe(1)
    expect(notified).toBe(1)
    expect(cachedUrls(parent)).toEqual([
      'https://github.com/a/b/pull/51',
      'https://github.com/a/b/pull/52',
      'https://github.com/a/b/pull/53',
    ])
  })
})

describe('codex subagent index listener', () => {
  test('fires when a link is new or changed, not when it is re-sent unchanged', () => {
    let calls = 0
    setCodexSubagentIndexListener(() => calls++)
    const link = { ownId: 'k1', parentId: 'p', logPath: '/x/k1.jsonl' }
    setCodexSubagentIndex([link])
    expect(calls).toBe(1)
    setCodexSubagentIndex([{ ...link }])
    expect(calls).toBe(1)
    registerCodexSubagent('k1', 'p', '/x/k1.jsonl')
    expect(calls).toBe(1)
    registerCodexSubagent('k2', 'p', '/x/k2.jsonl')
    expect(calls).toBe(2)
    setCodexSubagentIndex([{ ...link, parentId: 'q' }])
    expect(calls).toBe(3)
  })
})
