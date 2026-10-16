/** Recovery API regressions using real storage and an inert terminal adapter. */
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { initDatabase } from '../db'
import { PersistentSessions } from '../persistence/manager'
import { PersistenceRuntime } from '../persistence/runtime'
import { SessionMetadataClient } from '../sessionMetadataClient'
import type { MetadataRequest, MetadataResponse } from '../sessionMetadataWorker'
import { registerPersistenceRoutes } from '../persistence/routes'
import type { SessionManager } from '../SessionManager'
import type { Session } from '../../shared/types'
import type { HistoryDetail } from '../../shared/persistence'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) close()
})

function setup(metadataFor: Parameters<typeof registerPersistenceRoutes>[2]['metadataFor'] = () => ({ prs: [], media: [] })) {
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
    metadataFor,
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

test('errors map to client and server statuses', async () => {
  const { app, saved, addConversation } = setup()
  const missing = await app.request('/api/library/no-such-session/resume', {
    method: 'POST',
  })
  expect(missing.status).toBe(404)

  const malformed = await app.request(`/api/library/${saved.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  })
  expect(malformed.status).toBe(400)

  const badCursor = await app.request('/api/library?cursor=nope')
  expect(badCursor.status).toBe(400)

  // commandFor throws a plain Error: an unexpected failure, not the client's.
  addConversation('needs-launch')
  const unexpected = await app.request(`/api/library/${saved.id}/resume`, {
    method: 'POST',
  })
  expect(unexpected.status).toBe(500)
})


test('detail materializes all conversation names and lifecycle fields after the final scan', async () => {
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const scanning = new Promise<void>((resolve) => { started = resolve })
  const { app, saved, addConversation, runtime } = setup(async (record) => {
    if (record.sessionId === 'older') { started(); await waiting }
    return { prs: [], media: [] }
  })
  addConversation('older'); addConversation('current')
  const pending = app.request(`/api/library/${saved.id}`)
  await scanning
  await app.request(`/api/library/${saved.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed' }),
  })
  runtime.db.updateSession('current', { isHibernating: true, lastUserMessage: 'new message' })
  release()
  const detail = await (await pending).json() as HistoryDetail
  expect(detail.session.name).toBe('Renamed')
  const current = detail.conversations.find((row) => row.sessionId === 'current')!
  expect(current.displayName).toBe('Renamed')
  expect(current.isHibernating).toBe(true)
  expect(current.lastUserMessage).toBe('new message')
})

test('detail revalidates linked conversations and changed log identities after scans', async () => {
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const scanning = new Promise<void>((resolve) => { started = resolve })
  const paths: string[] = []
  const { app, saved, addConversation, runtime } = setup(async (record) => {
    paths.push(record.logFilePath)
    if (paths.length === 1) { started(); await waiting }
    return { prs: [], media: [{ kind: 'link', url: record.logFilePath }] }
  })
  addConversation('first')
  const pending = app.request(`/api/library/${saved.id}`)
  await scanning
  addConversation('newly-linked')
  runtime.db.updateSession('first', { logFilePath: '/changed.jsonl' })
  release()
  const detail = await (await pending).json() as HistoryDetail
  expect(detail.conversations).toHaveLength(2)
  expect(detail.conversations.find((row) => row.sessionId === 'first')?.media?.[0].url).toBe('/changed.jsonl')
  expect(paths).toContain('/changed.jsonl')
})


test('detail retries a real client cancellation when a pending HTTP scan is reassociated', async () => {
  const sent: MetadataRequest[] = []
  const worker = {
    onmessage: null as ((event: MessageEvent<MetadataResponse>) => void) | null,
    postMessage(message: MetadataRequest) { sent.push(message) },
  }
  const client = new SessionMetadataClient(() => {}, () => worker as unknown as Worker)
  cleanup.push(() => client.dispose())
  const { app, saved, addConversation, runtime } = setup((record) => client.scan(record))
  const original = addConversation('current')
  client.queue(original)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const pending = app.request(`/api/library/${saved.id}`)
  await new Promise((resolve) => setTimeout(resolve, 0))
  runtime.db.updateSession('current', { logFilePath: '/replacement.jsonl' })
  client.queue(runtime.db.getSessionById('current')!)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const scans = () => sent.filter((message) => message.kind === 'scan')
  worker.onmessage!(new MessageEvent<MetadataResponse>('message', { data: { id: scans()[0].id, metadata: { prs: [], media: [] } } }))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(scans()[1].record.logFilePath).toBe('/replacement.jsonl')
  worker.onmessage!(new MessageEvent<MetadataResponse>('message', { data: { id: scans()[1].id, metadata: { prs: [], media: [] } } }))
  const response = await pending
  expect(response.status).toBe(200)
  const detail = await response.json() as HistoryDetail
  expect(detail.conversations[0].logFilePath).toBe('/replacement.jsonl')
})
