// Team workspace subscriptions over the chat connection (team-workspace 5.1,
// 5.2; team-workspace-pages 1.4): teamPath addressing through the team-scope
// resolver, authoritative snapshots on open and reconnect, diffed full-set
// change pushes, close and disconnect, and team isolation between two
// repositories.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { AssignmentStore } from '../team/assignmentStore'
import { loadGroupCatalog, type GroupCatalog } from '../team/groupCatalog'
import { WorkspaceConnections } from '../team/workspaceConnections'
import { WorkspaceRead } from '../team/workspaceRead'
import { TeamApprovalDefaults } from '../team/teamApprovalDefaults'
import type { TeamIdentity } from '../team/teamIdentity'
import type { TeamTaskRow, TeamWorkspaceSnapshot } from '../../shared/teamWorkspace'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { ChatSessionRecord } from '../db'
import type { PlanAttentionFact, PlanSummaryRows } from '../team/planAttention'
import type { ChangeSupervision } from '../../shared/planSupervision'

let dir: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let manager: ChatSessionManager
let connections: ChatConnections
let messages: ServerMessage[]
let connection: { send: (message: ServerMessage) => void }
let records: Array<ChatSessionRecord & { teamId: string }>
let pendingRequests: Map<string, unknown[]>
let turnEndRows: Array<{ sessionId: string; taskId: string; endedAt: string }>
let catalog: GroupCatalog
// The plan-side facts the manager seam exposes (plan-supervision D13).
let planFacts: PlanAttentionFact[]
let planRows: PlanSummaryRows
let approvalDefaults: TeamApprovalDefaults

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-workspace-connections-'))
  fs.mkdirSync(path.join(dir, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.kawai', 'groups', 'devs.md'), '---\nlabel: Developers\n---\nBuild features')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  tasks = new TaskService(taskStore, { getSession: () => undefined })
  // homeDir pins the user-level layer to the temp dir: the operator's real
  // ~/.kawai/groups must never reach a fixture's member list.
  catalog = loadGroupCatalog({ groupsRoot: dir, homeDir: dir })
  approvalDefaults = new TeamApprovalDefaults(db.db)
  records = []
  pendingRequests = new Map()
  turnEndRows = []
  planFacts = []
  planRows = { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }
  messages = []
  connection = { send: message => messages.push(message) }
  // Known team paths (team-workspace-pages D1): this repository (two paths,
  // one team) and another team's.
  const teams = new Map<string, TeamIdentity>([
    ['/repo', { teamId: 'team', groupsRoot: dir }],
    ['/repo/.worktrees/feat-x', { teamId: 'team', groupsRoot: dir }],
    ['/other', { teamId: 'other', groupsRoot: dir }],
  ])
  manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: { resolve: async (teamPath: string) => teams.get(teamPath) },
    mailbox: { store: mail },
    tasks,
    waitingFor: () => ({}),
    teamRecords: (teamId: string) => records.filter(record => record.teamId === teamId),
    directory: { list: () => [] },
    getPendingRequests: (sessionId: string) => pendingRequests.get(sessionId) ?? [],
    groupProfileCounts: () => ({}),
    teamApprovalDefault: (teamId: string) => approvalDefaults.get(teamId),
    setTeamApprovalDefault: (teamId: string, policy: 'manual' | 'auto') => approvalDefaults.set(teamId, policy),
    turnEnds: {
      // Team scoping is the store's SQL join in production; the fake honors it.
      finishedForTeam: (teamId: string) => (teamId === 'team' ? turnEndRows.filter(row => row.sessionId === 'our-dev') : []),
      since: () => turnEndRows,
    },
    recordOf: (sessionId: string) => records.find(record => record.sessionId === sessionId),
    exhaustionEpisodes: () => [],
    planAttentionFacts: (teamId: string) => (teamId === 'team' ? planFacts : []),
    planSummaryRows: (teamId: string) => (teamId === 'team' ? planRows : { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }),
    validationDetail: { invalidate: () => {} },
    outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
    teams: {
      catalogForTeam: () => catalog,
      teamOf: (sessionId: string) => {
        const record = records.find(candidate => candidate.sessionId === sessionId)
        return record ? { teamId: record.teamId } : undefined
      },
    },
  } as unknown as ChatSessionManager
  connections = new ChatConnections(manager)
  taskStore.subscribe(task => connections.publishTasks(task.teamId))
  mail.subscribe(team => connections.publishMailbox(team))
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

// The morning summary's 24 h window reads the real clock, so fixtures must be relative to it.
const recent = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const send = (message: ClientMessage) => connections.handle(connection, message)
const human = (teamId = 'team') => ({ kind: 'human' as const, team: { teamId, groupsRoot: dir } })
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)
const recordOf = (overrides: Partial<ChatSessionRecord & { teamId: string }> = {}): ChatSessionRecord & { teamId: string } => ({
  sessionId: 'chat-1', name: 'Dev one', projectPath: '/repo', sdkSessionId: null,
  status: 'waiting', createdAt: '2026-10-14T00:00:00Z', lastActivityAt: '2026-10-14T01:00:00Z',
  groupId: 'devs', teamId: 'team', ...overrides,
})

/** One gathered fact with a stopped change (the store interface, plan-supervision D13). */
const stoppedFact = (): PlanAttentionFact => ({
  teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: null, executionId: 'exec-1',
  changes: [{
    taskId: null, generation: 0,
    supervision: {
      change: 'api', outcome: 'stopped',
      cause: { kind: 'stopped', reason: 'ci-timeout', detail: null },
      alsoApplying: [], stage: null, holder: null, progress: null, activity: null, stall: null, landing: null, lastRound: null,
    } satisfies ChangeSupervision,
  }],
  openCards: [], fixes: [], failedPromotion: null, correctionOpen: false,
})

test('open snapshots the team; a team with no tasks serializes empty lists', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const snapshot = last('team-workspace-snapshot')!
  expect(snapshot).toMatchObject({ teamPath: '/repo', teamId: 'team', tasks: [], attention: [], directory: [] })
  expect(snapshot.members.map(member => member.id)).toEqual(['devs'])
  expect(snapshot.summary.completedResults.items).toEqual([])
})

test('changes push full sets, an unchanged read stays quiet, close and disconnect unsubscribe', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const task = await tasks.create(human(), { title: 'Existing', direction: 'd' })
  await connections.flushWorkspace()
  expect(last('team-workspace')!.tasks.map(row => row.title)).toEqual(['Existing'])
  // The same unchanged state pushes nothing (diff before sending) — including
  // across a millisecond boundary: the window edge moves with every read, so
  // the diff key must not compare it.
  await Bun.sleep(5)
  const count = messages.length
  connections.publishWorkspace('team')
  await connections.flushWorkspace()
  expect(messages).toHaveLength(count)
  // A meaningful change pushes again.
  await tasks.setStatus(human(), task.id, 'active')
  await connections.flushWorkspace()
  expect(last('team-workspace')!.tasks[0]!.status).toBe('active')
  await send({ type: 'team-workspace-close', teamPath: '/repo' })
  await tasks.create(human(), { title: 'Unseen', direction: 'd' })
  await connections.flushWorkspace()
  const afterClose = messages.length
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  expect(messages).toHaveLength(afterClose + 1) // the re-open's snapshot only
  connections.disconnect(connection)
  await tasks.create(human(), { title: 'Unseen too', direction: 'd' })
  await connections.flushWorkspace()
  expect(messages).toHaveLength(afterClose + 1)
})

test('a reconnect gets a fresh authoritative snapshot', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  connections.disconnect(connection)
  await tasks.create(human(), { title: 'Made while away', direction: 'd' })
  const reconnected: ServerMessage[] = []
  await connections.handle({ send: message => reconnected.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
  expect(reconnected).toHaveLength(1)
  expect(reconnected[0]).toMatchObject({ type: 'team-workspace-snapshot', teamId: 'team', tasks: [{ title: 'Made while away' }] })
})

test('an unknown path is refused with no data', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/nowhere' })
  expect(messages).toEqual([{ type: 'error', message: 'unknown-team: /nowhere' }])
})

test('a worktree path and the main checkout reach the same team; each subscription gets its copy', async () => {
  await tasks.create(human(), { title: 'Shared', direction: 'd' })
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  await send({ type: 'team-workspace-open', teamPath: '/repo/.worktrees/feat-x' })
  expect(messages.filter(message => message.type === 'team-workspace-snapshot')).toHaveLength(2)
  // One change fans out to both subscriptions of the team, each under its own teamPath.
  messages.length = 0
  await tasks.create(human(), { title: 'Second', direction: 'd' })
  await connections.flushWorkspace()
  const pushes = messages.filter(message => message.type === 'team-workspace')
  expect(pushes.map(push => push.teamPath).sort()).toEqual(['/repo', '/repo/.worktrees/feat-x'])
})

test('a second repository stays isolated: no tasks, mail, or attention of the other team', async () => {
  const ours = await tasks.create(human(), { title: 'Ours', direction: 'd' })
  const theirs = await tasks.create(human('other'), { title: 'Theirs', direction: 'd' })
  records = [
    recordOf({ sessionId: 'our-dev', groupId: 'devs' }),
    recordOf({ sessionId: 'their-dev', groupId: 'devs', teamId: 'other', taskId: theirs.id }),
  ]
  pendingRequests.set('our-dev', [{
    kind: 'approval', requestId: 'req-1', tool: 'Bash', input: {},
    at: recent(65),
  }])
  mail.enqueue({ teamId: 'other', toKind: 'session', toId: 'their-dev', fromSession: 'x', fromGroup: null, originPath: dir, body: 'foreign', taskId: theirs.id })
  const ours_ = mail.enqueue({ teamId: 'team', toKind: 'session', toId: 'our-dev', fromSession: 'x', fromGroup: null, originPath: dir, body: 'ours', taskId: ours.id })
  mail.claim(ours_.id, 'our-dev')
  mail.holdUncertain(ours_.id, 'transcript missing')
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  const snapshot = last('team-workspace-snapshot')!
  expect(snapshot.tasks.map(row => row.title)).toEqual(['Ours'])
  expect(snapshot.attention.map(item => item.id)).toEqual(['approval:our-dev:req-1', `uncertain-delivery:${ours_.id}`])
  expect(snapshot.members[0]!.members.map(member => member.sessionId)).toEqual(['our-dev'])
  // Opening the other team beside the first keeps each to its own facts.
  messages.length = 0
  await send({ type: 'team-workspace-open', teamPath: '/other' })
  const other = last('team-workspace-snapshot')!
  expect(other.teamId).toBe('other')
  expect(other.tasks.map(row => row.title)).toEqual(['Theirs'])
  expect(other.attention.map(item => item.id)).toEqual([])
})

test('a pending approval appears live when the workspace is open', async () => {
  records = [recordOf({ sessionId: 'our-dev', groupId: 'devs' })]
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  expect(last('team-workspace-snapshot')!.attention).toEqual([])
  pendingRequests.set('our-dev', [{
    kind: 'approval', requestId: 'req-1', tool: 'Bash', input: {},
    at: recent(65),
  }])
  connections.publishWorkspace('team')
  await connections.flushWorkspace()
  expect(last('team-workspace')!.attention.map(item => item.id)).toEqual(['approval:our-dev:req-1'])
})

test('a plan write re-pushes the workspace with its attention item and summary bucket; unchanged facts stay quiet (plan-supervision D13, B1)', async () => {
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  expect(last('team-workspace-snapshot')!.attention).toEqual([])
  // An execution-side write (a stopped change) lands without any task or mail
  // change: publishPlans must re-project the workspace with the new item.
  planFacts = [stoppedFact()]
  planRows = { landings: [], stops: [{ planId: 'plan-1', planTitle: 'Wave D', change: 'api', stoppedAt: recent(30), reason: 'ci-timeout' }], stallAlerts: [], decisions: [], overrides: [] }
  connections.publishPlans('team', 'plan-1')
  await connections.flushWorkspace()
  const push = last('team-workspace')!
  expect(push.attention.map(item => item.id)).toEqual(['plan-stop:exec-1:api:0'])
  expect(push.summary.stops.items.map(item => item.id)).toEqual([`stop:plan-1:api:${planRows.stops[0]!.stoppedAt}`])
  // The same facts again: the workspace diff keeps the team quiet.
  const count = messages.length
  connections.publishPlans('team', 'plan-1')
  await connections.flushWorkspace()
  expect(messages).toHaveLength(count)
})

test('observeChatEvent maps request and turn events to workspace pushes (review item 4)', async () => {
  records = [recordOf({ sessionId: 'our-dev', groupId: 'devs', taskId: 'task-9' })]
  const task = await tasks.create(human(), { title: 'Worked on', direction: 'd' })
  records[0]!.taskId = task.id
  await send({ type: 'team-workspace-open', teamPath: '/repo' })
  expect(last('team-workspace-snapshot')!.attention).toEqual([])
  // An approval event becomes a human-required attention item on the next push.
  pendingRequests.set('our-dev', [{
    kind: 'approval', requestId: 'req-1', tool: 'Bash', input: {},
    at: recent(65),
  }])
  connections.observeChatEvent('our-dev', {
    type: 'approval_request', requestId: 'req-1', tool: 'Bash', input: {},
    id: 'evt-1', sequence: 1, turnId: 't-1', at: recent(65),
  })
  await connections.flushWorkspace()
  expect(last('team-workspace')!.attention.map(item => item.id)).toEqual(['approval:our-dev:req-1'])
  // A turn completion publishes, and the summary reads its bucket from the
  // durable chat_turn_ends table (written by the manager's event path, not
  // by the connection) — rows of this team's sessions only.
  turnEndRows = [
    { sessionId: 'our-dev', taskId: task.id, endedAt: recent(60) },
    { sessionId: 'other-dev', taskId: task.id, endedAt: recent(60) },
  ]
  connections.observeChatEvent('our-dev', {
    type: 'turn_completed', subtype: 'success',
    id: 'evt-2', sequence: 2, turnId: 't-1', at: recent(60),
  })
  await connections.flushWorkspace()
  const push = last('team-workspace')!
  expect(push.summary.finishedTurnsWithoutResult.items.map(item => item.id)).toEqual(['finished-turn:our-dev'])
  // A foreign session's event never touches this team's views.
  const count = messages.length
  connections.observeChatEvent('nobody', { type: 'turn_started', id: 'evt-3', sequence: 3, turnId: 't-2', at: recent(59) })
  await connections.flushWorkspace()
  expect(messages).toHaveLength(count)
})

/** A read that counts projections instead of computing them. */
class CountingRead extends WorkspaceRead {
  reads = 0
  failNext = false
  /** Keep throwing for this team id (per-team containment tests). */
  failFor: string | null = null
  constructor(public payload: TeamWorkspaceSnapshot, private readonly moveClock = false) { super(null as never) }
  snapshot(team: { teamId: string }): TeamWorkspaceSnapshot {
    this.reads += 1
    if (this.failFor !== null && team.teamId === this.failFor) throw new Error('projection blew up')
    if (this.failNext) {
      this.failNext = false
      throw new Error('projection blew up')
    }
    // A moving window edge on every read: exactly what the diff must ignore.
    return { ...this.payload, summary: { ...this.payload.summary, since: this.moveClock ? new Date().toISOString() : this.payload.summary.since } }
  }
}

describe('team default approval action (team-approval-default W1–W5)', () => {
  type Row = [id: string, teamPath: string, policy: unknown, ok: boolean, stored: 'manual' | 'auto' | null, publishes: boolean]
  // | id | caller / input                 | result                 | stored | publish |
  const TABLE: Row[] = [
    ['W1', '/repo', 'auto', true, 'auto', true],
    ['W2', '/repo', 'auto', true, 'auto', true],
    ['W3', '/nope', 'auto', false, null, false],
    ['W4', '/repo', 'always', false, null, false],
    ['W5', '/repo/.worktrees/feat-x', 'auto', true, 'auto', true],
  ]
  for (const [id, teamPath, policy, ok, stored, publishes] of TABLE) {
    // @covers: team-workspace › The Members tab sets the team's default approval policy › Another open view follows the change
    test(`${id}: ${teamPath} ${String(policy)} → ${ok ? 'ok' : 'refused'}, stored ${stored ?? 'none'}`, async () => {
      // W2 replays the same value over an existing row: the publish runs, and the diff keeps the unchanged read quiet.
      if (id === 'W2') approvalDefaults.set('team', 'auto')
      const other = { send: (message: ServerMessage) => watched.push(message) }
      const watched: ServerMessage[] = []
      await connections.handle(other, { type: 'team-workspace-open', teamPath: '/repo' })
      await send({ type: 'team-workspace-approval-default-set', teamPath, policy: policy as 'auto' })
      await connections.flushWorkspace()
      const result = last('team-workspace-approval-default-result')!
      // Every row carries the envelope's teamPath, refusals included.
      expect(result.teamPath).toBe(teamPath)
      expect(result.ok).toBe(ok)
      if (result.ok) expect(result.policy).toBe(policy as 'auto')
      else expect(result.error).toContain(id === 'W3' ? '/nope' : '"always"')
      expect(approvalDefaults.get('team')).toBe(stored)
      expect(approvalDefaults.get('/repo/.worktrees/feat-x')).toBeNull()
      const pushed = watched.filter(message => message.type === 'team-workspace')
      expect(pushed.length > 0).toBe(publishes && id !== 'W2')
      if (publishes && id !== 'W2') {
        const push = pushed.at(-1) as Extract<ServerMessage, { type: 'team-workspace' }>
        expect(push.approvalDefault).toBe('auto')
        expect(push.members.find(member => member.id === 'devs')).toMatchObject({ approval: 'auto', approvalSource: 'team' })
      }
    })
  }

  test('the other team never sees the default', async () => {
    await send({ type: 'team-workspace-approval-default-set', teamPath: '/repo', policy: 'auto' })
    await send({ type: 'team-workspace-open', teamPath: '/other' })
    const snapshot = last('team-workspace-snapshot')!
    expect(snapshot.approvalDefault).toBeNull()
    expect(snapshot.members.find(member => member.id === 'devs')).toMatchObject({ approval: 'manual', approvalSource: 'built-in' })
  })
})

describe('publishes coalesce and share one read per team', () => {
  const emptySnapshot = (): TeamWorkspaceSnapshot => ({
    tasks: [], attention: [], members: [], approvalDefault: null, directory: [],
    summary: {
      since: '2026-10-13T00:00:00Z', completedResults: { items: [] }, capacityWaits: { items: [] },
      approvals: { items: [] }, uncertainDeliveries: { items: [] }, finishedTurnsWithoutResult: { items: [] }, outbound: { items: [] },
      landings: { items: [] }, stops: { items: [] }, stallAlerts: { items: [] }, decisions: { items: [] }, overrides: { items: [] },
    },
  })
  const make = () => {
    const read = new CountingRead(emptySnapshot(), true)
    const workspace = new WorkspaceConnections(manager, read)
    return { workspace, read }
  }

  test('two subscribers on one team trigger one read', async () => {
    const { workspace, read } = make()
    const first: ServerMessage[] = []
    const second: ServerMessage[] = []
    await workspace.handle({ send: message => first.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    await workspace.handle({ send: message => second.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    expect(read.reads).toBe(2) // one per open — opens always read fresh
    read.reads = 0
    read.payload = { ...read.payload, tasks: [emptyRow()] } // a change worth pushing
    workspace.publish('team')
    await workspace.settled()
    expect(read.reads).toBe(1)
    expect(first.filter(message => message.type === 'team-workspace')).toHaveLength(1)
    expect(second.filter(message => message.type === 'team-workspace')).toHaveLength(1)
  })

  test('several publishes in one tick project the team once, and a moving clock does not re-send', async () => {
    const { workspace, read } = make()
    const sent: ServerMessage[] = []
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    read.reads = 0
    const count = sent.length
    workspace.publish('team')
    workspace.publish('team')
    workspace.publish('team')
    await workspace.settled()
    expect(read.reads).toBe(1)
    // The read moved `since` between the open and this publish; the payload
    // is unchanged, so nothing is sent.
    expect(sent).toHaveLength(count)
    // A changed payload does send.
    read.payload = { ...emptySnapshot(), tasks: [{ ...emptyRow() }] }
    workspace.publish('team')
    await workspace.settled()
    expect(sent.at(-1)).toMatchObject({ type: 'team-workspace', tasks: [{ id: 'task-1' }] })
  })

  test('a throwing read is contained: nothing escapes and the next publish still sends', async () => {
    const { workspace, read } = make()
    const sent: ServerMessage[] = []
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    read.failNext = true
    read.payload = { ...read.payload, tasks: [{ ...emptyRow() }] }
    let escaped: unknown = null
    try {
      workspace.publish('team')
      await workspace.settled()
    } catch (error) { escaped = error }
    // The throw was swallowed inside the coalescing microtask (an uncaught
    // one would exit Bun), and the failed team's message never went out.
    expect(escaped).toBeNull()
    expect(sent.filter(message => message.type === 'team-workspace')).toHaveLength(0)
    // The schedule survives: the next publish reads and sends again.
    workspace.publish('team')
    await workspace.settled()
    expect(sent.at(-1)).toMatchObject({ type: 'team-workspace', tasks: [{ id: 'task-1' }] })
  })

  test('one failing team in a burst does not wedge the other team', async () => {
    const { workspace, read } = make()
    const sent: ServerMessage[] = []
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/repo' })
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/other' })
    read.failFor = 'team'
    read.payload = { ...read.payload, tasks: [{ ...emptyRow() }] }
    const count = sent.length
    let escaped: unknown = null
    try {
      workspace.publish('team')
      workspace.publish('other')
      await workspace.settled()
    } catch (error) { escaped = error }
    expect(escaped).toBeNull()
    // The failing team sent nothing; the healthy one in the same burst did.
    const pushes = sent.slice(count).filter(message => message.type === 'team-workspace')
    expect(pushes.map(push => push.teamPath)).toEqual(['/other'])
  })

  test('opening a second team view keeps the first view diff keys (review nit)', async () => {
    const { workspace } = make()
    const sent: ServerMessage[] = []
    const open = (teamPath: string) => workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath })
    await open('/repo')
    await open('/other')
    // Unchanged payload: the first view's publish must stay quiet. Under the
    // old code the second open replaced the connection's whole key map, so
    // this pushed a redundant full set.
    workspace.publish('team')
    await workspace.settled()
    expect(sent.filter(message => message.type === 'team-workspace')).toHaveLength(0)
  })

  test('one teamId split across groups roots (a bare repository) reads once per identity', async () => {
    // teamIdentity.test pins the ordinary case: a main checkout and a linked
    // worktree resolve to one identity, so one read covers both. A bare
    // repository's worktrees share the teamId but not the groups root.
    const read = new CountingRead(emptySnapshot())
    const manager = {
      teamScopes: {
        resolve: async (teamPath: string) =>
          teamPath === '/wt-a' ? { teamId: 'bare', groupsRoot: '/wt-a' } : { teamId: 'bare', groupsRoot: '/wt-b' },
      },
    } as unknown as ChatSessionManager
    const workspace = new WorkspaceConnections(manager, read)
    const sent: ServerMessage[] = []
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/wt-a' })
    await workspace.handle({ send: message => sent.push(message) }, { type: 'team-workspace-open', teamPath: '/wt-b' })
    const afterOpens = read.reads
    read.payload = { ...read.payload, tasks: [{ ...emptyRow() }] }
    workspace.publish('bare')
    await workspace.settled()
    expect(read.reads - afterOpens).toBe(2) // one projection per identity
    const pushes = sent.filter(message => message.type === 'team-workspace')
    expect(pushes.map(push => push.teamPath).sort()).toEqual(['/wt-a', '/wt-b'])
  })
})

const emptyRow = (): TeamTaskRow => ({
  id: 'task-1', title: 'T', status: 'open', stage: 'unstarted', accountable: null, groupId: null,
  worktree: null, waitingReason: null, needsReevaluation: false, acknowledgement: null, nextAction: null, requiresHuman: false,
})
