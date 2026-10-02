import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setScannedPrCacheLimitForTests, toAgentSession } from '../agentSessions'
import { createDormantPrScanner } from '../dormantPrScan'
import type { AgentSessionRecord } from '../db'
import { clearPrScanCache } from '../prExtractor'

let tempRoot: string
let counter = 0

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-dormant-'))
  clearPrScanCache()
})

afterEach(async () => {
  setScannedPrCacheLimitForTests()
  await fs.rm(tempRoot, { recursive: true, force: true })
})

function prLines(n: number): string {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      sessionId: `s${n}`,
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'gh pr create --fill' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: `s${n}`,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: `https://github.com/a/b/pull/${n}` },
        ],
      },
    }),
  ]
  return `${lines.join('\n')}\n`
}

async function makeRecord(withPr: boolean): Promise<AgentSessionRecord> {
  const n = ++counter
  const logFilePath = path.join(tempRoot, `log-${n}.jsonl`)
  await fs.writeFile(logFilePath, withPr ? prLines(n) : '{}\n')
  const size = (await fs.stat(logFilePath)).size
  return {
    id: n,
    sessionId: `dormant-session-${n}`,
    logFilePath,
    projectPath: '/p',
    slug: null,
    agentType: 'claude',
    displayName: 'x',
    createdAt: '2024-01-01T00:00:00.000Z',
    lastActivityAt: '2024-01-02T00:00:00.000Z',
    lastUserMessage: null,
    currentWindow: null,
    isHibernating: false,
    lastResumeError: null,
    wakeStartedAt: null,
    lastKnownLogSize: size,
    isCodexExec: false,
    launchCommand: null,
  }
}

/** Rewrites or appends to the record's log and returns it with the new size. */
async function changeLog(
  record: AgentSessionRecord,
  content: string,
  mode: 'append' | 'replace'
): Promise<AgentSessionRecord> {
  if (mode === 'append') await fs.appendFile(record.logFilePath, content)
  else await fs.writeFile(record.logFilePath, content)
  return { ...record, lastKnownLogSize: (await fs.stat(record.logFilePath)).size }
}

const cachedPrCount = (record: AgentSessionRecord) =>
  toAgentSession(record, { cachedPrsOnly: true }).prs?.length

describe('dormant PR scan', () => {
  test('cachedPrsOnly does not read the log; eager mode does', async () => {
    const record = await makeRecord(true)
    expect(toAgentSession(record, { cachedPrsOnly: true }).prs).toEqual([])
    const eager = toAgentSession(record)
    expect(eager.prs?.map((pr) => pr.url)).toEqual(['https://github.com/a/b/pull/' + counter])
    // Now remembered: cached mode returns it without scanning.
    await fs.rm(record.logFilePath)
    expect(toAgentSession(record, { cachedPrsOnly: true }).prs).toHaveLength(1)
  })

  test('scanner fills PRs in batches and notifies once drained', async () => {
    const records = [
      await makeRecord(false),
      await makeRecord(true),
      await makeRecord(true),
    ]
    let notified = 0
    const scanner = createDormantPrScanner(
      () => {
        notified++
        // Mirrors updateDormantAgentSessions re-queueing everything.
        scanner.queue(records)
      },
      { budgetMs: 0, gapMs: 1, notifyMs: 60_000 }
    )
    scanner.queue(records)
    // budgetMs 0 processes one record per slice, so nothing is scanned yet.
    expect(records.map((r) => toAgentSession(r, { cachedPrsOnly: true }).prs?.length)).toEqual([0, 0, 0])
    await Bun.sleep(80)
    expect(notified).toBe(1)
    expect(records.map((r) => toAgentSession(r, { cachedPrsOnly: true }).prs?.length)).toEqual([0, 1, 1])
    scanner.stop()
  })

  test('rescans when the same log grows and notifies only on a PR change', async () => {
    let record = await makeRecord(false)
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, { gapMs: 1, notifyMs: 0 })
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(0)

    // Growth without a PR: rescanned, same (empty) list, no notify.
    record = await changeLog(record, '{"type":"user"}\n', 'append')
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(0)

    // Growth that adds a PR to the same file: notify once.
    record = await changeLog(record, prLines(record.id), 'append')
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    expect(cachedPrCount(record)).toBe(1)

    // More growth, same PR list: no redundant notify.
    record = await changeLog(record, '{"type":"user"}\n', 'append')
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    scanner.stop()
  })

  test('notifies when a rewritten log no longer holds the PR', async () => {
    let record = await makeRecord(true)
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, { gapMs: 1, notifyMs: 0 })
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    expect(cachedPrCount(record)).toBe(1)

    record = await changeLog(record, '{"type":"user","note":"rewritten"}\n', 'replace')
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(2)
    expect(cachedPrCount(record)).toBe(0)
    scanner.stop()
  })

  test('does not loop when the dormant set exceeds the PR cache cap', async () => {
    setScannedPrCacheLimitForTests(2)
    const records = [
      await makeRecord(true),
      await makeRecord(true),
      await makeRecord(true),
      await makeRecord(true),
    ]
    let notified = 0
    const scanner = createDormantPrScanner(
      () => {
        notified++
        scanner.queue(records)
      },
      { budgetMs: 0, gapMs: 1, notifyMs: 60_000 }
    )
    scanner.queue(records)
    await Bun.sleep(150)
    expect(notified).toBe(1)
    scanner.stop()
  })

  test('a throwing callback does not stall the remaining slices', async () => {
    const records = [await makeRecord(true), await makeRecord(true)]
    let calls = 0
    const scanner = createDormantPrScanner(
      () => {
        calls++
        if (calls === 1) throw new Error('boom')
      },
      { budgetMs: 0, gapMs: 1, notifyMs: 0 }
    )
    scanner.queue(records)
    await Bun.sleep(60)
    expect(calls).toBe(2)
    expect(records.map(cachedPrCount)).toEqual([1, 1])
    scanner.stop()
  })
})
