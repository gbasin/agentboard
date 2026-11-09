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
    // Repairs must run even when the transcript's revision has not changed.
    for (const stale of [
      'This session is being continued from a previous conversation that ran out of context. Summary',
      '<image name=[Image #1] path="/tmp/paste.png">',
      '[Image #2]',
      '<system-reminder id="4506f64571faf1f5">cached coordinator message',
    ]) {
      db.updateSession('rewrite', { lastUserMessage: stale })
      expect((await ingest()).lastUserMessage).toBe('later')
    }
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

for (const hibernating of [false, true]) {
  test(`slug supersession rolls back insert failure and retries (${hibernating ? 'hibernating' : 'live'})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-supersede-'))
    const logPath = path.join(root, '.claude', 'projects', '-tmp-project', 'successor.jsonl')
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const db = initDatabase({ path: path.join(root, 'catalog.db') })
    const worker = new LogMatchWorkerClient()
    const events: string[] = []
    const poller = new LogPoller(db, new SessionRegistry(), {
      matchWorkerClient: worker, devinSyncClient: null,
      onSessionOrphaned: id => events.push(`orphan:${id}`),
      onSessionActivated: id => events.push(`active:${id}`),
    })
    try {
      const predecessor = db.insertSession({
        sessionId: 'predecessor', logFilePath: path.join(root, 'old.jsonl'),
        projectPath: '/tmp/project', slug: 'shared-slug', agentType: 'claude',
        displayName: 'Inherited name', createdAt: '2026-01-01T00:00:00.000Z',
        lastActivityAt: '2026-01-01T00:00:00.000Z', lastUserMessage: 'prior',
        currentWindow: 'isolated:1', isHibernating: hibernating,
        lastResumeError: null, lastKnownLogSize: 0, isCodexExec: false, launchCommand: null,
      })
      fs.writeFileSync(logPath, JSON.stringify({ type: 'user', sessionId: 'successor',
        cwd: '/tmp/project', slug: 'shared-slug', timestamp: '2026-01-02T00:00:00.000Z',
        message: { role: 'user', content: 'execute the plan' } }) + '\n')
      const response = await worker.poll({ windows: [], logDirs: [path.dirname(logPath)],
        preFilteredPaths: [logPath], sessions: [], knownSessions: [],
        maxLogsPerPoll: 25, scrollbackLines: 100, buildCodexSubagentIndex: false,
      })
      db.db.exec("CREATE TRIGGER fail_successor BEFORE INSERT ON agent_sessions WHEN NEW.session_id = 'successor' BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END")
      const failed = poller['processMatchResponse'](response, [], [], new Map())
      expect(failed.errors).toBe(1)
      expect(db.getSessionById('predecessor')).toEqual(predecessor)
      expect(db.getSessionById('successor')).toBeNull()
      expect(events).toEqual([])
      db.db.exec('DROP TRIGGER fail_successor')
      const retry = poller['processMatchResponse'](response, [], [], new Map())
      expect(retry.errors).toBe(0)
      expect(retry.newSessions).toBe(1)
      const successor = db.getSessionById('successor')!
      expect(successor.displayName).toBe(predecessor.displayName)
      expect(successor.currentWindow).toBe(predecessor.currentWindow)
      expect(successor.isHibernating).toBe(hibernating)
      expect(db.getSessionById('predecessor')?.currentWindow).toBeNull()
      expect(db.getSessionById('predecessor')?.isHibernating).toBe(false)
      expect(events).toEqual(['orphan:predecessor', 'active:successor'])
      poller['processMatchResponse'](response, [], [], new Map())
      expect(events.length).toBe(2)
    } finally {
      worker.dispose()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
}


test('disappeared transcript does not acknowledge revision or clear metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-disappeared-'))
  try {
    const entry = { logPath: path.join(root, 'removed.jsonl'), size: 10 } as LogEntrySnapshot
    attachLastUserMessage(entry, new Map())
    expect(entry.revision).toBeUndefined()
    expect(entry.lastUserMessage).toBeUndefined()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('database supersession validates original ownership while successor claims a different window', () => {
  const db = initDatabase({ path: ':memory:' })
  try {
    const predecessor = db.insertSession({
      sessionId: 'dormant', logFilePath: '/isolated/old.jsonl', projectPath: '/isolated',
      slug: 'plan', agentType: 'claude', displayName: 'Plan',
      createdAt: '2026-01-01T00:00:00.000Z', lastActivityAt: '2026-01-01T00:00:00.000Z',
      lastUserMessage: null, currentWindow: null, isHibernating: true,
      lastResumeError: null, lastKnownLogSize: 0, isCodexExec: false, launchCommand: null,
    })
    const successor = db.supersedeSession(predecessor, {
      ...predecessor, sessionId: 'resumed', logFilePath: '/isolated/new.jsonl', currentWindow: 'isolated:2',
    })
    expect(successor.currentWindow).toBe('isolated:2')
    expect(successor.isHibernating).toBe(true)
    expect(db.getSessionById('dormant')?.isHibernating).toBe(false)
    expect(() => db.supersedeSession(predecessor, { ...successor, sessionId: 'stale-retry' })).toThrow('predecessor changed')
    expect(db.getSessionById('stale-retry')).toBeNull()
  } finally { db.close() }
})
