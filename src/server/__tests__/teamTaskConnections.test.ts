// Task subscriptions and human actions over the chat connection (team-tasks
// 6.1/6.2, task-assignment 4.2/4.3): team-scoped list/detail snapshots,
// delayed team resolution, cross-team refusal, every human action including
// reopening a task whose creator was killed, and assignment dispatch,
// preview, and targets with their result messages.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let teams: Map<string, TeamIdentity>
let resolveDelay: Promise<void> | null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-connections-'))
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
  fs.mkdirSync(path.join(dir, 'openspec', 'changes', 'add-x'), { recursive: true })
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  // Known team paths (team-workspace-pages D1): this repository and another team's.
  teams = new Map([['/repo', { teamId: 'team', groupsRoot: dir }], ['/other', { teamId: 'other', groupsRoot: dir }]])
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => [],
    teamOf: () => undefined,
    caps: new TeamCaps({}),
    worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, taskStore, mail, {
    getSession: () => undefined,
    records: () => [],
    teamOf: () => undefined,
    staffing, caps: new TeamCaps({}), worktrees,
  })
  resolveDelay = null
  messages = []
  connection = { send: message => messages.push(message) }
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: {
      resolve: async (teamPath: string) => { if (resolveDelay) await resolveDelay; return teams.get(teamPath) },
    },
    mailbox: { store: mail }, dispatcher: { notify: () => {} }, tasks, assignments,
    directory: { list: () => [{ sessionId: 'gone', name: 'Killed helper', group: 'qa' }] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
  // As ChatSessionManager wires it: a draft refreshes the human's views only (task-revision-publication D1).
  taskStore.drafts.subscribe(taskId => { const task = taskStore.get(taskId); if (task) connections.publishTasks(task.teamId) })
  mail.subscribe((team, message) => connections.publishMailbox(team, message))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)

test('list open snapshots the team, changes push, close and disconnect unsubscribe', async () => {
  const existing = await tasks.create(human(), { title: 'Existing', direction: 'd' })
  await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  expect(last('team-tasks-snapshot')).toMatchObject({ teamPath: '/repo', teamId: 'team', tasks: [{ id: existing.id, title: 'Existing' }] })
  await tasks.create(human(), { title: 'Second', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks.map(task => task.title)).toEqual(['Existing', 'Second'])
  await tasks.create(human('other'), { title: 'Elsewhere', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks).toHaveLength(2)
  await send({ type: 'team-tasks-close', teamPath: '/repo' })
  const count = messages.length
  await tasks.create(human(), { title: 'Unseen', direction: 'd' })
  expect(messages).toHaveLength(count)
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  connections.disconnect(connection)
  const after = messages.length
  await tasks.create(human(), { title: 'Unseen too', direction: 'd' })
  expect(messages).toHaveLength(after)
})

test('a reconnect gets a fresh authoritative snapshot', async () => {
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  connections.disconnect(connection)
  await tasks.create(human(), { title: 'Made while away', direction: 'd' })
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, { type: 'team-tasks-open', teamPath: '/repo' })
  expect(reconnected).toMatchObject([{ type: 'team-tasks-snapshot', tasks: [{ title: 'Made while away' }] }])
})

test('detail open sends revisions, journal, subtasks, participants, and task mail; updates push', async () => {
  const task = await tasks.create(human(), { title: 'Parent', direction: 'v1' })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail).toMatchObject({ task: { id: task.id }, revisions: [{ revision: 1 }], journal: [], subtasks: [], messages: [] })
  await tasks.create(human(), { title: 'Child', direction: 'c', parent_id: task.id })
  await tasks.amend(human(), task.id, { direction: 'v2' })
  const sent = mail.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: dir, body: 'go', taskId: task.id })
  const detail = last('team-task-detail')!.detail
  // The detail names its message participants; a killed one keeps its name.
  expect(last('team-task-detail')!.directory).toEqual([{ sessionId: 'gone', name: 'Killed helper', group: 'qa' }])
  expect(detail.revisions.map(revision => revision.direction)).toEqual(['v1', 'v2'])
  expect(detail.subtasks.map(child => child.title)).toEqual(['Child'])
  expect(detail.messages.map(row => row.id)).toEqual([sent.id])
  expect(detail.task.participants).toEqual(['lead'])
  await send({ type: 'team-task-close', teamPath: '/repo', taskId: task.id })
  const count = messages.filter(message => message.type === 'team-task-detail').length
  await tasks.note(human(), task.id, 'later')
  expect(messages.filter(message => message.type === 'team-task-detail')).toHaveLength(count)
})

test('another team’s task cannot be opened or acted on', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: foreign.id })
  expect(messages.at(-1)).toEqual({ type: 'error', message: 'Task does not belong to this team' })
  for (const action of [
    { type: 'team-task-note', teamPath: '/repo', requestId: 'r1', taskId: foreign.id, text: 'x' },
    { type: 'team-task-status', teamPath: '/repo', requestId: 'r2', taskId: foreign.id, status: 'done' },
    { type: 'team-task-draft', teamPath: '/repo', requestId: 'r3', taskId: foreign.id, action: 'save', direction: 'x' },
    { type: 'team-task-publish', teamPath: '/repo', requestId: 'r4', taskId: foreign.id, baseRevision: 1, requestKey: 'k', direction: 'x', rationale: 'r', notify: true },
    { type: 'team-task-notify', teamPath: '/repo', requestId: 'r5', taskId: foreign.id, revision: 1, requestKey: 'k' },
  ] as ClientMessage[]) {
    await send(action)
    expect(last('team-task-result')!.error).toContain('not found in this team')
  }
  expect(tasks.store.get(foreign.id)).toMatchObject({ status: 'open', revision: 1 })
  expect(tasks.store.journal(foreign.id)).toEqual([])
  expect(tasks.store.drafts.get(foreign.id)).toBeNull()
})

test('delayed team resolution: a close sent meanwhile wins over the earlier open', async () => {
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const opening = send({ type: 'team-tasks-open', teamPath: '/repo' })
  await send({ type: 'team-tasks-close', teamPath: '/repo' })
  release(); await opening
  expect(messages).toEqual([])
  resolveDelay = null
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  expect(last('team-tasks-snapshot')).toBeDefined()
})

test('a team path that names no known team is refused, with each action answered on its own result type', async () => {
  await send({ type: 'team-tasks-open', teamPath: '/elsewhere' })
  expect(messages).toEqual([{ type: 'error', message: 'unknown-team: /elsewhere' }])
  await send({ type: 'team-task-create', teamPath: '/elsewhere', requestId: 'r', title: 't', direction: 'd' })
  expect(last('team-task-result')).toEqual({ type: 'team-task-result', teamPath: '/elsewhere', requestId: 'r', error: 'unknown-team: /elsewhere' })
  expect(tasks.store.list('team')).toEqual([])
  await send({ type: 'team-task-preview', teamPath: '/elsewhere', requestId: 'p', target: { kind: 'group', id: 'devs' } })
  expect(last('team-task-preview-result')).toEqual({ type: 'team-task-preview-result', teamPath: '/elsewhere', requestId: 'p', error: 'unknown-team: /elsewhere' })
  await send({ type: 'team-task-targets', teamPath: '/elsewhere', requestId: 't' })
  expect(last('team-task-targets-result')).toEqual({ type: 'team-task-targets-result', teamPath: '/elsewhere', requestId: 't', error: 'unknown-team: /elsewhere' })
})

test('human create with parent and change, draft and publish, note, and status answer by request id and push revisions', async () => {
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  await send({ type: 'team-task-create', teamPath: '/repo', requestId: 'c1', title: 'Parent', direction: 'p' })
  const parent = last('team-task-result')!.task!
  await send({ type: 'team-task-create', teamPath: '/repo', requestId: 'c2', title: 'Child', direction: 'v1', acceptance: 'ok', parentId: parent.id, openspecChange: 'add-x' })
  const created = last('team-task-result')!
  expect(created).toMatchObject({ requestId: 'c2', task: { title: 'Child', parentId: parent.id, openspecChange: 'add-x', creator: { kind: 'human' } } })
  const id = created.task!.id
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: id })
  // The draft is pushed in the human detail and publishes nothing (task-revision-publication D1).
  await send({ type: 'team-task-draft', teamPath: '/repo', requestId: 'd1', taskId: id, action: 'save', direction: 'v2', rationale: 'Scope' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'd1', task: { revision: 1 } })
  expect(last('team-task-detail')!.detail).toMatchObject({ task: { revision: 1 }, draft: { baseRevision: 1, direction: 'v2' } })
  await send({ type: 'team-task-publish', teamPath: '/repo', requestId: 'a1', taskId: id, baseRevision: 1, requestKey: 'publish-a1', direction: 'v2', rationale: 'Scope', notify: false, fromDraft: true })
  expect(last('team-task-result')).toMatchObject({ requestId: 'a1', task: { revision: 2 }, revision: 2, replay: false })
  expect(last('team-task-detail')!.detail.revisions.map(revision => revision.direction)).toEqual(['v1', 'v2'])
  expect(last('team-task-detail')!.detail.draft).toBeNull()
  await send({ type: 'team-task-note', teamPath: '/repo', requestId: 'n1', taskId: id, text: 'Human note' })
  expect(last('team-task-detail')!.detail.journal).toMatchObject([{ text: 'Human note', author: { kind: 'human' } }])
  await send({ type: 'team-task-status', teamPath: '/repo', requestId: 's1', taskId: id, status: 'blocked' })
  expect(last('team-task-result')).toMatchObject({ requestId: 's1', task: { status: 'blocked' } })
  expect(last('team-tasks-snapshot')!.tasks.find(task => task.id === id)?.status).toBe('blocked')
})

test('invalid references come back as errors and create nothing', async () => {
  for (const [requestId, extra, error] of [
    ['p', { parentId: 'task-missing' }, 'Parent task not found'],
    ['w', { worktree: path.join(dir, 'nowhere') }, 'is not a worktree'],
    ['o', { openspecChange: 'missing-change' }, 'OpenSpec change not found'],
  ] as const) {
    await send({ type: 'team-task-create', teamPath: '/repo', requestId, title: 't', direction: 'd', ...extra })
    expect(last('team-task-result')).toMatchObject({ requestId })
    expect(last('team-task-result')!.error).toContain(error)
  }
  expect(tasks.store.list('team')).toEqual([])
})

test('the human reopens and closes a task whose agent creator was killed', async () => {
  const task = tasks.store.create({ teamId: 'team', title: 'Orphan', direction: 'd', creator: { kind: 'agent', sessionId: 'killed-lead' } })
  tasks.store.setStatus(task.id, 'done')
  await send({ type: 'team-task-status', teamPath: '/repo', requestId: 'r', taskId: task.id, status: 'open' })
  expect(last('team-task-result')).toMatchObject({ task: { status: 'open', creator: { kind: 'agent', sessionId: 'killed-lead' } } })
  await send({ type: 'team-task-status', teamPath: '/repo', requestId: 'r2', taskId: task.id, status: 'cancelled' })
  expect(tasks.store.get(task.id)!.status).toBe('cancelled')
})

test('list and detail opened together both subscribe (header link opens the panel on a task)', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'd' })
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const list = send({ type: 'team-tasks-open', teamPath: '/repo' })
  const detail = send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  release(); await Promise.all([list, detail])
  expect(last('team-tasks-snapshot')!.tasks.map(row => row.id)).toEqual([task.id])
  expect(last('team-task-detail')!.detail.task.id).toBe(task.id)
  // The list stays subscribed: a later task change still pushes it.
  resolveDelay = null
  await tasks.create(human(), { title: 'Import', direction: 'd' })
  expect(last('team-tasks-snapshot')!.tasks.map(row => row.title)).toEqual(['Export', 'Import'])
})

test('reconnect with a detail open resubscribes both list and detail', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'd' })
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  connections.disconnect(connection)
  messages = []
  // The client's effects re-run in order: both closes, then both opens, unawaited.
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const pending = [
    send({ type: 'team-tasks-close', teamPath: '/repo' }),
    send({ type: 'team-task-close', teamPath: '/repo', taskId: task.id }),
    send({ type: 'team-tasks-open', teamPath: '/repo' }),
    send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id }),
  ]
  release(); await Promise.all(pending)
  expect(messages.map(message => message.type).sort()).toEqual(['team-task-detail', 'team-tasks-snapshot'])
  resolveDelay = null
  await tasks.note(human(), task.id, 'after reconnect')
  expect(last('team-tasks-snapshot')).toBeDefined()
  expect(last('team-task-detail')!.detail.journal.map(entry => entry.text)).toEqual(['after reconnect'])
  expect(messages.filter(message => message.type === 'team-tasks-snapshot').length).toBeGreaterThan(1)
})

test('a close still supersedes a pending open of the same detail only', async () => {
  const a = await tasks.create(human(), { title: 'A', direction: 'd' })
  const b = await tasks.create(human(), { title: 'B', direction: 'd' })
  let release!: () => void
  resolveDelay = new Promise(resolve => { release = resolve })
  const openA = send({ type: 'team-task-open', teamPath: '/repo', taskId: a.id })
  const openB = send({ type: 'team-task-open', teamPath: '/repo', taskId: b.id })
  await send({ type: 'team-task-close', teamPath: '/repo', taskId: a.id })
  release(); await Promise.all([openA, openB])
  expect(messages.filter(message => message.type === 'team-task-detail').map(message => (message as { detail: { task: { id: string } } }).detail.task.id)).toEqual([b.id])
})

test('human dispatch assigns a task and returns its assignment; snapshots carry it', async () => {
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  await send({ type: 'team-task-create', teamPath: '/repo', requestId: 'c1', title: 'Export', direction: 'CSV', requestKey: 'intent-1' })
  const task = last('team-task-result')!.task!
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a1', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Please build it', requestKey: 'intent-1',
  })
  const result = last('team-task-result')!
  expect(result).toMatchObject({ requestId: 'a1', assignment: { targetKind: 'group', targetId: 'devs', state: 'queued', role: 'devs' } })
  expect(result.task!.id).toBe(task.id)
  expect(last('team-tasks-snapshot')!.tasks[0]!.assignment!.id).toBe(result.assignment!.id)
  // A same-key replay returns the first assignment; the list still has one instruction.
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a2', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Please build it', requestKey: 'intent-1',
  })
  expect(last('team-task-result')!.assignment!.id).toBe(result.assignment!.id)
  expect(mail.forTask(task.id)).toHaveLength(1)
})

// @covers: team-tasks › task_list returns compact rows › Human views stay whole
test('the human\'s list and detail keep direction, acceptance, assignment, and participants (bounded-task-list D1)', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV for every account', acceptance: 'A file downloads' })
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a1', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Please build the export', requestKey: 'intent-whole',
  })
  db.db.prepare("UPDATE team_messages SET state = 'claimed', claimed_by = 'dev' WHERE task_id = ?").run(task.id)
  await tasks.note(human(), task.id, 'refresh the views')
  const listed = last('team-tasks-snapshot')!.tasks.find(row => row.id === task.id)!
  expect(listed).toMatchObject({
    direction: 'CSV for every account', acceptance: 'A file downloads',
    assignment: { instruction: 'Please build the export', targetId: 'devs' }, participants: ['dev'],
  })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail.task).toMatchObject({
    direction: 'CSV for every account', acceptance: 'A file downloads',
    assignment: { instruction: 'Please build the export' }, participants: ['dev'],
  })
})

test('dispatch refusals answer inline and create nothing', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  for (const [requestId, message, error] of [
    ['a1', { type: 'team-task-assign', teamPath: '/repo', requestId: 'a1', taskId: task.id, target: { kind: 'group', id: 'ghosts' }, instruction: 'Go', requestKey: 'k' }, 'Unknown group'],
    ['a2', { type: 'team-task-assign', teamPath: '/repo', requestId: 'a2', taskId: 'task-missing', target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k2' }, 'not found in this team'],
    ['a3', { type: 'team-task-assign', teamPath: '/other', requestId: 'a3', taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k3' }, 'not found in this team'],
    ['a4', { type: 'team-task-assign', teamPath: '/repo', requestId: 'a4', taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: '  ', requestKey: 'k4' }, 'instruction'],
  ] as Array<[string, ClientMessage, string]>) {
    await send(message)
    expect(last('team-task-result')).toMatchObject({ requestId, error: expect.stringContaining(error) })
  }
  expect(mail.forTask(task.id)).toEqual([])
  expect(tasks.store.list('team')[0]!.assignment).toBeNull()
})

test('a reassignment without handling is refused naming the outstanding assignment', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a1', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k1',
  })
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a2', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Redo', requestKey: 'k2',
  })
  expect(last('team-task-result')!.error).toContain('outstanding assignment: group devs, queued')
})

test('assignment state transitions arrive as refreshed snapshots through the mail republish path', async () => {
  await send({ type: 'team-tasks-open', teamPath: '/repo' })
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  await send({
    type: 'team-task-assign', teamPath: '/repo', requestId: 'a1', taskId: task.id,
    target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k1',
  })
  const assignment = last('team-task-result')!.assignment!
  // Claim, requeue, dead-letter: each mail change republishes the task snapshot.
  mail.claim(assignment.messageId!, 'chat-dev')
  expect(last('team-tasks-snapshot')!.tasks[0]!.assignment).toMatchObject({ state: 'claimed', claimedBy: 'chat-dev' })
  mail.requeue(assignment.messageId!)
  expect(last('team-tasks-snapshot')!.tasks[0]!.assignment).toMatchObject({ state: 'queued', claimedBy: null })
  mail.deadLetter(assignment.messageId!, 'killed-recipient')
  // Failed is not outstanding: the list shows the task unassigned again.
  expect(last('team-tasks-snapshot')!.tasks[0]!.assignment).toBeNull()
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail.assignments[0]).toMatchObject({ state: 'failed', reason: 'killed-recipient' })
})

test('preview answers through its result message; an invalid worktree errors inline', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'CSV' })
  await send({
    type: 'team-task-preview', teamPath: '/repo', requestId: 'p1', taskId: task.id, target: { kind: 'group', id: 'devs' },
  })
  expect(last('team-task-preview-result')).toMatchObject({
    requestId: 'p1',
    preview: { worktree: null, target: { kind: 'group', id: 'devs' }, role: 'Developers', idleMembers: [] },
  })
  await send({
    type: 'team-task-preview', teamPath: '/repo', requestId: 'p2', worktree: path.join(dir, 'nowhere'), target: { kind: 'group', id: 'devs' },
  })
  expect(last('team-task-preview-result')).toMatchObject({ requestId: 'p2', error: expect.stringContaining('is not a worktree') })
  await send({ type: 'team-task-preview', teamPath: '/repo', requestId: 'p3', target: { kind: 'group', id: 'ghosts' } })
  expect(last('team-task-preview-result')!.error).toContain('Unknown group')
})

test('targets list the team-scoped worktrees and changes', async () => {
  await send({ type: 'team-task-targets', teamPath: '/repo', requestId: 't1' })
  const targets = last('team-task-targets-result')!.targets!
  expect(targets.changes.map(change => change.name)).toEqual(['add-x'])
  expect(targets.changes[0]!.locations).toEqual([dir])
  // A plain directory: no git worktrees to list.
  expect(targets.worktrees).toEqual([])
  await send({ type: 'team-task-targets', teamPath: '/other', requestId: 't2' })
  expect(last('team-task-targets-result')!.targets).toEqual({ worktrees: [], changes: [{ name: 'add-x', locations: [dir] }], plans: [] })
  // The change list narrows to the roots the chosen worktree validates for;
  // an unknown worktree errors inline.
  await send({ type: 'team-task-targets', teamPath: '/repo', requestId: 't3', worktree: '/nope' })
  expect(last('team-task-targets-result')).toMatchObject({ requestId: 't3', error: expect.stringContaining('is not a worktree') })
})

test('publish refusals come back inline; replays, notify, rebase, and acknowledgements answer and push (task-revision-publication 5.1)', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  const publish = (requestId: string, extra: Record<string, unknown> = {}) => send({
    type: 'team-task-publish', teamPath: '/repo', requestId, taskId: task.id, baseRevision: 1, requestKey: 'publish-1',
    direction: 'v2', rationale: 'Scope', notify: false, ...extra,
  } as ClientMessage)
  await publish('p0', { rationale: '  ' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'p0', error: 'A publication needs a rationale' })
  await publish('p1')
  await publish('p2')
  expect(last('team-task-result')).toMatchObject({ requestId: 'p2', revision: 2, replay: true })
  await publish('p3', { direction: 'other' })
  expect(last('team-task-result')!.error).toContain('Request key already used with a different direction')
  // A draft based on revision 1 is now stale: publishing it is refused, the draft kept, and rebase fixes the base.
  await send({ type: 'team-task-draft', teamPath: '/repo', requestId: 'd1', taskId: task.id, action: 'save', baseRevision: 1, direction: 'v3' })
  await publish('p4', { requestKey: 'publish-2', direction: 'v3' })
  expect(last('team-task-result')!.error).toContain('revision 2 was published since revision 1')
  expect(last('team-task-detail')!.detail.draft).toMatchObject({ baseRevision: 1, direction: 'v3' })
  await send({ type: 'team-task-draft', teamPath: '/repo', requestId: 'd2', taskId: task.id, action: 'rebase' })
  expect(last('team-task-detail')!.detail.draft).toMatchObject({ baseRevision: 2, direction: 'v3' })
  await send({ type: 'team-task-draft', teamPath: '/repo', requestId: 'd3', taskId: task.id, action: 'discard' })
  expect(last('team-task-detail')!.detail.draft).toBeNull()
  await send({ type: 'team-task-notify', teamPath: '/repo', requestId: 'n1', taskId: task.id, revision: 2, requestKey: 'notify-1' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'n1', replay: false, task: { revision: 2 } })
  await send({ type: 'team-task-notify', teamPath: '/repo', requestId: 'n2', taskId: task.id, revision: 3, requestKey: 'notify-2' })
  expect(last('team-task-result')!.error).toContain('Revision 3 of this task is not published')
  // An acknowledgement republishes the detail with the new history.
  const before = messages.filter(message => message.type === 'team-task-detail').length
  tasks.store.acknowledgements.record(task.id, 'dev', 2, null)
  tasks.store.touch(task.id)
  expect(messages.filter(message => message.type === 'team-task-detail')).toHaveLength(before + 1)
  expect(last('team-task-detail')!.detail.acknowledgements).toMatchObject([{ sessionId: 'dev', revision: 2 }])
})
