// Task-result human actions over the chat connection (task-results-handoffs
// 3.3/5.2/6.2): accept-result, handoff, and release, each answered by
// team-task-result with refusals inline, every one refused across teams,
// and the task detail carrying results to subscribers.
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
import { MemberRelease } from '../team/memberRelease'
import type { ChatSessionRecord } from '../db'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import type { ClientMessage, ServerMessage } from '../../shared/types'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let results: TaskResultService
let assignments: AssignmentService
let connections: ChatConnections
let messages: ServerMessage[]
let records: Map<string, ChatSessionRecord>
let busy: Set<string>
let archived: string[]
const connection = { send: (message: ServerMessage) => { messages.push(message) } }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-result-connections-'))
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'reviewers.md'), '---\nlabel: Reviewers\n---\nReview')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const teams = new Map([['/repo', { teamId: 'team', groupsRoot: dir }], ['/other', { teamId: 'other', groupsRoot: dir }]])
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  const worktrees = new TeamWorktrees()
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => [], teamOf: () => undefined, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, taskStore, mail, {
    getSession: () => undefined, records: () => [], teamOf: () => undefined, staffing, caps: new TeamCaps({}), worktrees,
  })
  records = new Map()
  busy = new Set()
  archived = []
  const releases = new MemberRelease(db.db, {
    store: mail, tasks: taskStore, records: () => records.values(), getRecord: id => records.get(id), teamOf: () => undefined,
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: id => ({ idle: !busy.has(id), pendingRequest: false }), hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: id => { archived.push(id); records.get(id)!.archivedAt = 'now'; return { ok: true } }, notify: () => {},
  })
  results = new TaskResultService(tasks, { getSession: () => undefined, assignments, releases, records: () => records.values() })
  messages = []
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail }, dispatcher: { notify: () => {} }, tasks, assignments, results,
    directory: { list: () => [] },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)
/** A result submitted by an agent (the store path; this harness has no agent sessions). */
const resultFor = (taskId: string, revision = 1) => tasks.store.results.insert({
  teamId: tasks.store.get(taskId)!.teamId, taskId, summary: 'CSV export', commit: 'abc123', diff: null, worktree: null,
  tests: [], limitations: null, taskRevision: revision, submittedBy: { kind: 'agent', sessionId: 'dev' },
})

test('accept-result closes the task and pushes the result; a flagged result is refused inline until a reason is given', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = resultFor(task.id)
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  await tasks.amend(human(), task.id, { direction: 'v2' })
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'a1', taskId: task.id, resultId: result.id })
  expect(last('team-task-result')!.error).toContain('needs a stated reason; nothing was accepted')
  expect(tasks.store.get(task.id)?.status).toBe('open')
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'a2', taskId: task.id, resultId: result.id, reason: 'Cosmetic change' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'a2', task: { status: 'done' } })
  expect(last('team-task-detail')!.detail.results).toMatchObject([{ id: result.id, acceptedBy: { kind: 'human' }, needsReevaluation: true }])
})

test('accept-result on another team\'s task is refused and writes nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  const result = resultFor(foreign.id)
  await send({ type: 'team-task-accept-result', teamPath: '/repo', requestId: 'x', taskId: foreign.id, resultId: result.id, reason: 'r' })
  expect(last('team-task-result')!.error).toContain('not found in this team')
  expect(tasks.store.results.get(result.id)!.acceptedAt).toBeNull()
  expect(tasks.store.get(foreign.id)?.status).toBe('open')
})

test('handoff dispatches a review of a result to a role; the same key replays; the detail shows the handoff assignment', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = resultFor(task.id)
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  const request = { type: 'team-task-handoff' as const, teamPath: '/repo', taskId: task.id, kind: 'review' as const, resultId: result.id,
    target: { kind: 'group' as const, id: 'reviewers' }, instructions: 'Review the export', requestKey: 'handoff-1' }
  await send({ ...request, requestId: 'h1' })
  const first = last('team-task-result')!
  expect(first).toMatchObject({ requestId: 'h1', replay: false, assignment: { handoffKind: 'review', resultId: result.id, targetId: 'reviewers' } })
  await send({ ...request, requestId: 'h2' })
  expect(last('team-task-result')).toMatchObject({ requestId: 'h2', replay: true, assignment: { id: first.assignment!.id } })
  expect(mail.forTask(task.id)).toHaveLength(1)
  expect(last('team-task-detail')!.detail.assignments).toMatchObject([{ id: first.assignment!.id, handoffKind: 'review', state: 'queued' }])
  // A replay of the key for another result is refused inline.
  const newer = resultFor(task.id)
  await send({ ...request, requestId: 'h3', resultId: newer.id })
  expect(last('team-task-result')!.error).toContain('Request key already used with a different')
})

test('handoff on another team\'s task is refused and dispatches nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  const result = resultFor(foreign.id)
  await send({ type: 'team-task-handoff', teamPath: '/repo', requestId: 'x', taskId: foreign.id, kind: 'review', resultId: result.id,
    target: { kind: 'group', id: 'reviewers' }, instructions: 'Review', requestKey: 'k' })
  expect(last('team-task-result')!.error).toContain('not found in this team')
  expect(mail.forTask(foreign.id)).toEqual([])
})

/** A task in a worktree, its spawned developer, a manual session beside it, and a result. */
async function developed() {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const worktree = path.join(dir, 'wt')
  fs.mkdirSync(path.join(worktree, '.git'), { recursive: true })
  db.db.prepare('UPDATE team_tasks SET worktree = ? WHERE id = ?').run(worktree, task.id)
  const session = (sessionId: string, extra: Partial<ChatSessionRecord>): ChatSessionRecord => ({ sessionId, name: sessionId,
    projectPath: worktree, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', groupId: 'devs', ...extra })
  records.set('dev', session('dev', { spawned: true, taskId: task.id }))
  records.set('manual', session('manual', { name: 'Manual session' }))
  return { task, result: resultFor(task.id) }
}
const release = (taskId: string, requestId: string) => send({ type: 'team-task-release', teamPath: '/repo', requestId, taskId,
  target: 'reviewers', instructions: 'Review the export', requestKey: 'release-1' })

test('the detail says when a running execution owns the task', async () => {
  const { task } = await developed()
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail.executionOwned).toBeUndefined()
  results.ownedByExecution = () => true
  await send({ type: 'team-task-close', teamPath: '/repo', taskId: task.id })
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail.executionOwned).toBe(true)
})

test('the detail carries the release dialog\'s data; a busy developer refuses inline; then one release and one review handoff', async () => {
  const { task, result } = await developed()
  await send({ type: 'team-task-open', teamPath: '/repo', taskId: task.id })
  expect(last('team-task-detail')!.detail.release).toEqual({
    members: [{ sessionId: 'dev', name: 'dev', ready: true, reason: null }], others: [{ sessionId: 'manual', name: 'Manual session' }],
    outstandingResultId: result.id, unavailable: null,
  })
  busy.add('dev')
  await release(task.id, 'r1')
  expect(last('team-task-result')!.error).toContain('Cannot release the worktree yet — nothing was archived or dispatched. dev (dev): it is busy')
  expect(archived).toEqual([])
  busy.delete('dev')
  await release(task.id, 'r2')
  expect(last('team-task-result')).toMatchObject({ requestId: 'r2', replay: false, assignment: { handoffKind: 'review', resultId: result.id } })
  expect(archived).toEqual(['dev'])
  expect(mail.forTask(task.id).filter(message => message.toId === 'reviewers')).toHaveLength(1)
  expect(last('team-task-detail')!.detail.release).toMatchObject({ members: [], unavailable: expect.stringContaining('No live spawned member') })
})

test('release on another team\'s task is refused and archives nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  records.set('dev', { sessionId: 'dev', name: 'dev', projectPath: dir, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
    spawned: true, taskId: foreign.id })
  await release(foreign.id, 'x')
  expect(last('team-task-result')!.error).toContain('not found in this team')
  expect(archived).toEqual([])
})

// Recheck (independent-verification D4): the human's command records a new
// check beside the earlier ones; a request while a check is pending returns
// that pending check instead of starting another.
// @covers: task-results › Results can be rechecked › Recheck while pending
test('recheck records a check requested by the human; a request while pending returns it', async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  const result = resultFor(task.id)
  await send({ type: 'team-task-recheck', teamPath: '/repo', requestId: 'r1', taskId: task.id, resultId: result.id })
  expect(last('team-task-result')!.task?.id).toBe(task.id)
  const checks = tasks.store.checks.allForResult(result.id)
  expect(checks).toHaveLength(1)
  expect(checks[0]).toMatchObject({ trigger: 'recheck', status: 'pending', requestedBy: { kind: 'human' } })
  // A request while that check is pending returns it — one row, not two.
  await send({ type: 'team-task-recheck', teamPath: '/repo', requestId: 'r2', taskId: task.id, resultId: result.id })
  expect(tasks.store.checks.allForResult(result.id)).toHaveLength(1)
})

test('recheck on another team\'s task is refused and writes nothing', async () => {
  const foreign = await tasks.create(human('other'), { title: 'Foreign', direction: 'd' })
  const result = resultFor(foreign.id)
  await send({ type: 'team-task-recheck', teamPath: '/repo', requestId: 'x', taskId: foreign.id, resultId: result.id })
  expect(last('team-task-result')!.error).toBeTruthy()
  expect(tasks.store.checks.allForResult(result.id)).toHaveLength(0)
})
