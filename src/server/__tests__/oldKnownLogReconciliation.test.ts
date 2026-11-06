import { expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attachLastUserMessage, handleMatchWorkerRequest } from '../logMatchWorker'
import { collectLogEntriesForPaths } from '../logPollData'
import { getEntriesNeedingMatch } from '../logMatchGate'
import { initDatabase } from '../db'
import { readPollSnapshot } from '../sessionReads'

test('old known logs skip unchanged extraction and matching while rewrites and unknown logs reconcile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-old-known-'))
  const originalClaude = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  const logPath = path.join(root, 'projects', 'old', 'session.jsonl')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const line = (text: string) => JSON.stringify({ type: 'user', sessionId: 'old', cwd: root,
    message: { role: 'user', content: text } }) + '\n'
  const db = initDatabase({ path: ':memory:' })
  try {
    fs.writeFileSync(logPath, line('original'))
    const seed = collectLogEntriesForPaths([logPath])[0]!
    attachLastUserMessage(seed, new Map())
    db.insertSession({ sessionId: 'old', logFilePath: logPath, projectPath: root, slug: 'old',
      agentType: 'claude', displayName: 'old', createdAt: '2020-01-01T00:00:00.000Z',
      lastActivityAt: '2020-01-01T00:00:00.000Z', lastUserMessage: 'original',
      currentWindow: null, isHibernating: false, lastResumeError: null,
      lastKnownLogSize: seed.size, lastKnownLogRevision: seed.revision, isCodexExec: false, launchCommand: null })
    const snapshot = readPollSnapshot(db.db, { maxAgeHours: 72 })
    expect(snapshot.lists.history).toHaveLength(0)
    const request = { id: 'old-known', windows: [], sessions: [], knownSessions: snapshot.knownSessions,
      preFilteredPaths: [logPath], logDirs: [root], maxLogsPerPoll: 5, scrollbackLines: 100 }
    const originalOpen = fs.openSync
    let transcriptOpens = 0
    const spy = spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      if (file === logPath) transcriptOpens++
      return (originalOpen as (...args: unknown[]) => number)(file, ...args)
    }) as typeof fs.openSync)
    try {
      const unchanged = handleMatchWorkerRequest(request)
      expect(unchanged.type).toBe('result')
      expect(transcriptOpens).toBe(0)
      expect(getEntriesNeedingMatch(unchanged.entries!, [])).toHaveLength(0)
      fs.writeFileSync(logPath, line('replaced')) // Equal size, changed revision.
      const changed = handleMatchWorkerRequest(request)
      expect(changed.entries?.[0]?.lastUserMessage).toBe('replaced')
      expect(transcriptOpens).toBeGreaterThan(0)
      expect(getEntriesNeedingMatch(changed.entries!, [])).toHaveLength(1)
      const unknown = handleMatchWorkerRequest({ ...request, knownSessions: [] })
      expect(unknown.entries?.[0]?.agentType).toBe('claude')
      expect(getEntriesNeedingMatch(unknown.entries!, [])).toHaveLength(1)
      // A known transcript larger than the parser's 2MB budget must also be
      // skipped without opening its contents on later unchanged sweeps.
      fs.appendFileSync(logPath, JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(3 * 1024 * 1024) } }) + '\n')
      const large = handleMatchWorkerRequest(request).entries![0]!
      db.updateSession('old', { lastKnownLogSize: large.size, lastKnownLogRevision: large.revision })
      const updated = readPollSnapshot(db.db, { maxAgeHours: 72 })
      transcriptOpens = 0
      const largeUnchanged = handleMatchWorkerRequest({ ...request, knownSessions: updated.knownSessions })
      expect(transcriptOpens).toBe(0)
      expect(getEntriesNeedingMatch(largeUnchanged.entries!, [])).toHaveLength(0)
      // Old reconciliation cannot suppress an unrelated newly discovered log.
      expect(getEntriesNeedingMatch([...largeUnchanged.entries!, ...unknown.entries!], [])).toHaveLength(1)
    } finally { spy.mockRestore() }
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
    if (originalClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalClaude
  }
})
