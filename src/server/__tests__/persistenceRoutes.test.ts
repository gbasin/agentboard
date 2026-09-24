/** Recovery API regressions using real storage and an inert terminal adapter. */
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { initDatabase } from '../db'
import { PersistentSessions } from '../persistence/manager'
import { PersistenceRuntime } from '../persistence/runtime'
import { registerPersistenceRoutes } from '../persistence/routes'
import type { SessionManager } from '../SessionManager'
import type { Session } from '../../shared/types'
import type { HistoryDetail } from '../../shared/persistence'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-routes-'))
  const db = initDatabase({ path: path.join(root, 'agentboard.db') })
  cleanup.push(() => {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const windows: Session[] = []
  const identity = {
    epoch: 'test',
    windows: new Map<string, { boardId: string; runId: string }>(),
  }
  const manager = { listWindows: () => windows } as unknown as SessionManager
  const sessions = new PersistentSessions(db, manager, 'test', () => identity)
  const runtime = new PersistenceRuntime(sessions, db)
  const app = new Hono()
  registerPersistenceRoutes(app, runtime, {
    commandFor: () => {
      throw new Error('Must not launch an agent')
    },
    changed() {},
    activated() {},
  })
  const saved = sessions.catalog.create({
    name: 'A',
    projectPath: root,
    command: 'sh',
  })
  const addConversation = (id: string) => {
    const record = db.insertSession({
      sessionId: id,
      logFilePath: path.join(root, id + '.jsonl'),
      projectPath: root,
      slug: null,
      agentType: 'codex',
      displayName: id,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      lastUserMessage: null,
      currentWindow: null,
      isHibernating: false,
      lastResumeError: null,
      lastKnownLogSize: null,
      isCodexExec: false,
      launchCommand: null,
    })
    sessions.catalog.associate(saved.id, id, 'codex')
    return record
  }
  return { app, sessions, runtime, saved, addConversation, windows, identity }
}

test('opening a tagged running terminal succeeds when its provider log is missing', async () => {
  const { app, sessions, saved, addConversation, windows, identity } = setup()
  addConversation('missing-log')
  const run = sessions.catalog.beginRun(saved.id)
  sessions.catalog.bind(saved.id, run.id, 'ab:@1', identity.epoch)
  identity.windows.set('ab:@1', { boardId: saved.id, runId: run.id })
  windows.push({
    id: 'ab:@1',
    tmuxWindow: 'ab:@1',
    name: 'A',
    projectPath: saved.projectPath,
    status: 'unknown',
    source: 'managed',
    createdAt: saved.createdAt,
    lastActivity: saved.lastActivityAt,
  })
  const response = await app.request(`/api/library/${saved.id}/resume`, {
    method: 'POST',
  })
  expect(response.status).toBe(200)
  expect((await response.json()).tmuxWindow).toBe('ab:@1')
  identity.windows.set('ab:@1', { boardId: 'different-session', runId: run.id })
  expect(sessions.findLive(sessions.catalog.get(saved.id)!)).toBeNull()
})

test('details keep all linked conversations attached to the session', async () => {
  const { app, saved, addConversation } = setup()
  for (const id of ['older', 'current']) addConversation(id)
  const detail = (await (
    await app.request(`/api/library/${saved.id}`)
  ).json()) as HistoryDetail
  expect(detail.session.providerId).toBe('current')
  expect(detail.conversations.map((c) => c.sessionId).sort()).toEqual([
    'current',
    'older',
  ])
})

test('invalid combined updates do not partially rename a saved session', async () => {
  const { app, saved, sessions } = setup()
  const result = await app.request(`/api/library/${saved.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Changed', pinned: 'yes' }),
  })
  expect(result.status).toBe(400)
  expect(sessions.catalog.get(saved.id)?.name).toBe('A')
})
