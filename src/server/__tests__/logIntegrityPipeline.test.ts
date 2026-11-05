import { test, expect } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { LogPoller } from '../logPoller'
import { SessionRegistry } from '../SessionRegistry'
import { LogMatchWorkerClient } from '../logMatchWorkerClient'
import { attachLastUserMessage } from '../logMatchWorker'
import type { LogEntrySnapshot } from '../logPollData'

// Real worker + SQLite ingestion. Explicit directories and zero windows ensure
// this never discovers user transcripts or invokes live tmux.
test('worker pipeline replaces shrinking/equal-size prompts, clears removed prompts, and ignores touches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-integrity-'))
  const logPath = path.join(root, '.claude', 'projects', '-tmp-project', 'session.jsonl')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const db = initDatabase({ path: path.join(root, 'catalog.db') })
  const worker = new LogMatchWorkerClient()
  let locked = false
  const poller = new LogPoller(db, new SessionRegistry(), {
    matchWorkerClient: worker, devinSyncClient: null,
    isLastUserMessageLocked: () => locked,
  })
  const line = (text: string, timestamp: string) => JSON.stringify({
    type: 'user', sessionId: 'rewrite', cwd: '/tmp/project', timestamp,
    message: { role: 'user', content: text },
  }) + '\n'
  const ingest = async () => {
    const record = db.getSessionById('rewrite')
    const response = await worker.poll({ windows: [], logDirs: [path.dirname(logPath)],
      preFilteredPaths: [logPath], sessions: record ? [record] : [],
      knownSessions: db.getKnownSessionKeys(), maxLogsPerPoll: 25, scrollbackLines: 100,
      buildCodexSubagentIndex: false, orphanCandidates: [],
    })
    expect(response.type).toBe('result')
    poller['processMatchResponse'](response, [], record ? [record] : [], new Map())
    return db.getSessionById('rewrite')!
  }
  try {
    fs.writeFileSync(logPath, line('a much longer prompt', '2026-01-03T00:00:00.000Z'))
    expect((await ingest()).lastUserMessage).toBe('a much longer prompt')
    fs.writeFileSync(logPath, line('short', '2026-01-01T00:00:00.000Z'))
    expect((await ingest()).lastUserMessage).toBe('short')
    expect((await ingest()).lastActivityAt).toBe('2026-01-01T00:00:00.000Z')
    fs.writeFileSync(logPath, line('other', '2026-01-02T00:00:00.000Z'))
    expect((await ingest()).lastUserMessage).toBe('other')
    const before = db.getSessionById('rewrite')!
    fs.utimesSync(logPath, new Date(), new Date())
    expect((await ingest()).lastActivityAt).toBe(before.lastActivityAt)
    db.updateSession('rewrite', { currentWindow: 'private:1', lastUserMessage: 'captured Enter' })
    locked = true
    fs.writeFileSync(logPath, line('later', '2026-01-04T00:00:00.000Z'))
    expect((await ingest()).lastUserMessage).toBe('captured Enter')
    locked = false
    expect((await ingest()).lastUserMessage).toBe('later')
    fs.appendFileSync(logPath, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(3 * 1024 * 1024) } }) + '\n')
    expect((await ingest()).lastUserMessage).toBe('later')
    fs.writeFileSync(logPath, JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', message: { content: 'done' } }) + '\n')
    expect((await ingest()).lastUserMessage).toBeNull()
    fs.writeFileSync(logPath, '')
    expect((await ingest()).lastUserMessage).toBeNull()
    expect((await ingest()).lastUserMessage).toBeNull()
    fs.appendFileSync(logPath, line('appended', '2026-01-05T00:00:00.000Z'))
    expect((await ingest()).lastUserMessage).toBe('appended')
  } finally {
    worker.dispose()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('disappeared transcript does not acknowledge revision or clear metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-disappeared-'))
  try {
    const entry = { logPath: path.join(root, 'removed.jsonl'), size: 10 } as LogEntrySnapshot
    attachLastUserMessage(entry, new Map())
    expect(entry.revision).toBeUndefined()
    expect(entry.lastUserMessage).toBeUndefined()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
