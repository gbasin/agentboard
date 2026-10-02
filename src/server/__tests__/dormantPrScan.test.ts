import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { toAgentSession } from '../agentSessions'
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
  await fs.rm(tempRoot, { recursive: true, force: true })
})

async function makeRecord(withPr: boolean): Promise<AgentSessionRecord> {
  const n = ++counter
  const logFilePath = path.join(tempRoot, `log-${n}.jsonl`)
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
  await fs.writeFile(logFilePath, withPr ? `${lines.join('\n')}\n` : '{}\n')
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

  test('rescans when the known log size changes', async () => {
    const record = await makeRecord(false)
    let notified = 0
    const scanner = createDormantPrScanner(() => notified++, { gapMs: 1 })
    scanner.queue([record])
    await Bun.sleep(30)
    expect(notified).toBe(0)
    const grown = await makeRecord(true)
    const next = { ...grown, sessionId: record.sessionId }
    scanner.queue([next])
    await Bun.sleep(30)
    expect(notified).toBe(1)
    expect(toAgentSession(next, { cachedPrsOnly: true }).prs).toHaveLength(1)
    scanner.stop()
  })
})
