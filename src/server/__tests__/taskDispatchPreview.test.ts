// The dispatch preview with a worker choice (dispatch-worker-choice 4.2,
// design D10, task-assignment "Human dispatch can name a worker"): a group
// preview's members and spawn profile come from the dispatcher's own pure
// eligibility check, with the router's cooling skip; a chosen worker narrows
// them, and a cooling choice warns with the cooldown end without refusing.
// Without a worker the preview answers byte-for-byte what it answered before.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WORKER_GROUP_TARGET_ONLY } from '../team/workerChoiceCheck'
import { recordRecipient } from './helpers/recordRecipient'

let dir: string
let worktree: string
let db: SessionDatabase
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let records: Map<string, ChatSessionRecord>
let cooldowns: Map<string, string>
let staffing: WorktreeStaffing
const team = () => ({ teamId: 'team', groupsRoot: dir })
const human = () => ({ kind: 'human' as const, team: team() })
const FUTURE = '2099-01-01T00:00:00.000Z'

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-dispatch-preview-')))
  // An empty home: the shipped catalog, claude {default, opus, sonnet, haiku} and zai {glm, glm-flash}.
  const home = path.join(dir, 'home')
  fs.mkdirSync(home)
  worktree = path.join(dir, 'wt')
  fs.mkdirSync(path.join(worktree, '.git'), { recursive: true })
  const groups = path.join(dir, '.kawai', 'groups')
  fs.mkdirSync(groups, { recursive: true })
  fs.writeFileSync(path.join(groups, 'devs.md'), '---\nprofiles: [sonnet, glm-flash]\nmax: 4\n---\nBuild features')
  fs.writeFileSync(path.join(groups, 'capped.md'), '---\nprofiles: { sonnet: 1, glm-flash: 1 }\n---\nCapped')
  fs.writeFileSync(path.join(groups, 'pair.md'), '---\nprofiles: { sonnet: 2, glm-flash: 1 }\n---\nPaired')
  fs.writeFileSync(path.join(groups, 'strict.md'), '---\nprofiles: [sonnet]\napproval: manual\n---\nStrict')
  fs.writeFileSync(path.join(groups, 'solo.md'), '---\nprofiles: { sonnet: 1 }\nmax: 3\n---\nSolo')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  mail = new MailboxStore(db.db)
  const assignmentStore = new AssignmentStore(db.db, mail)
  const taskStore = new TaskStore(db.db, mail, assignmentStore)
  records = new Map()
  cooldowns = new Map()
  tasks = new TaskService(taskStore, { getSession: id => records.get(id) })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => records.has(id) ? team() : undefined
  staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(), teamOf, caps: new TeamCaps({}), worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(db.db, assignmentStore, taskStore, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf,
    staffing, caps: new TeamCaps({}), worktrees, homeDir: home,
    cooldownUntil: profileId => cooldowns.get(profileId) ?? null,
    recipient: id => recordRecipient(records.get(id), 'team', mail),
  })
})
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) })

const member = (sessionId: string, extra: Partial<ChatSessionRecord> = {}) => records.set(sessionId, {
  sessionId, name: sessionId, projectPath: worktree, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  groupId: 'devs', claudeProfileId: 'sonnet', ...extra,
})
const worktreeTask = async () => {
  const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
  db.db.prepare('UPDATE team_tasks SET worktree = ? WHERE id = ?').run(worktree, task.id)
  return task
}
const preview = (taskId: string, group: string, worker?: string) =>
  assignments.preview(human(), { taskId, target: { kind: 'group', id: group }, ...(worker !== undefined ? { worker } : {}) })
const pendingSpawn = (group: string, profileId: string) => db.db.prepare(`INSERT INTO team_spawns
  (id, message_id, team_id, group_id, worktree, created_at, profile_id) VALUES (?, ?, 'team', ?, ?, '', ?)`)
  .run(`spawn-${profileId}`, `message-${profileId}`, group, path.join(dir, 'other'), profileId)

describe('without a worker the preview is unchanged', () => {
  test('a spawnable worktree task names the first allowed profile', async () => {
    const task = await worktreeTask()
    expect(JSON.stringify(await preview(task.id, 'devs'))).toBe(`{"worktree":"${worktree}","target":{"kind":"group","id":"devs"},"role":"devs","profile":"sonnet","approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":[],"spawn":{"allowed":true,"profile":"sonnet","blockedBy":null},"warning":null}`)
  })

  test('an occupied worktree blocks the spawn but still names the profile', async () => {
    const task = await worktreeTask()
    member('dev', { spawned: true, status: 'working' })
    expect(JSON.stringify(await preview(task.id, 'devs'))).toBe(`{"worktree":"${worktree}","target":{"kind":"group","id":"devs"},"role":"devs","profile":"sonnet","approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":[],"spawn":{"allowed":false,"profile":"sonnet","blockedBy":"a spawned member already works in ${worktree}"},"warning":null}`)
  })

  test('every allowed profile cooling reads as before', async () => {
    const task = await worktreeTask()
    cooldowns.set('sonnet', FUTURE).set('glm-flash', FUTURE)
    expect(JSON.stringify(await preview(task.id, 'devs'))).toBe(`{"worktree":"${worktree}","target":{"kind":"group","id":"devs"},"role":"devs","profile":null,"approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":[],"spawn":{"allowed":false,"profile":null,"blockedBy":"every allowed profile is at its cap or cooling down"},"warning":null}`)
  })

  test('a cooling first profile skips to the next, as before', async () => {
    const task = await worktreeTask()
    cooldowns.set('sonnet', FUTURE)
    expect(JSON.stringify(await preview(task.id, 'devs'))).toBe(`{"worktree":"${worktree}","target":{"kind":"group","id":"devs"},"role":"devs","profile":"glm-flash","approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":[],"spawn":{"allowed":true,"profile":"glm-flash","blockedBy":null},"warning":null}`)
  })

  test('a task without a worktree reads as before', async () => {
    const task = await tasks.create(human(), { title: 'Export', direction: 'v1' })
    member('idle', { projectPath: path.join(dir, 'elsewhere') })
    expect(JSON.stringify(await preview(task.id, 'devs'))).toBe(`{"worktree":null,"target":{"kind":"group","id":"devs"},"role":"devs","profile":"sonnet","approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":["idle"],"spawn":{"allowed":false,"profile":"sonnet","blockedBy":"the task has no target worktree"},"warning":null}`)
  })

  test('the group cap reads as before', async () => {
    const task = await worktreeTask()
    member('a', { groupId: 'capped', projectPath: path.join(dir, 'a') })
    member('b', { groupId: 'capped', claudeProfileId: 'glm-flash', projectPath: path.join(dir, 'b') })
    expect(JSON.stringify(await preview(task.id, 'capped'))).toBe(`{"worktree":"${worktree}","target":{"kind":"group","id":"capped"},"role":"capped","profile":null,"approval":"manual","approvalSource":"built-in","sessionWorktree":null,"idleMembers":[],"spawn":{"allowed":false,"profile":null,"blockedBy":"group capped is at its max of 2 live members"},"warning":null}`)
  })
})

describe('with a worker the preview applies the choice through the eligibility check', () => {
  test('the choice changes the effective profile and names the worker', async () => {
    const task = await worktreeTask()
    const answer = await preview(task.id, 'devs', 'zai')
    expect(answer).toMatchObject({ profile: 'glm-flash', spawn: { allowed: true, profile: 'glm-flash', blockedBy: null }, warning: null,
      worker: { selector: 'zai', profiles: ['glm-flash'], cooldownUntil: null } })
    expect((await preview(task.id, 'devs', 'glm-flash')).worker).toEqual({ selector: 'zai/glm-flash', profiles: ['glm-flash'], cooldownUntil: null })
  })

  test('the choice narrows the idle members to its workers', async () => {
    const task = await worktreeTask()
    member('sonnet-dev')
    member('glm-dev', { claudeProfileId: 'glm-flash' })
    expect((await preview(task.id, 'devs')).idleMembers).toEqual(['sonnet-dev', 'glm-dev'])
    expect((await preview(task.id, 'devs', 'zai')).idleMembers).toEqual(['glm-dev'])
  })

  // @covers: task-assignment › The dispatch preview reflects the worker choice › Cooling choice in the preview
  test('a cooling choice warns with the cooldown end, spawn reads false with its reason, and dispatch stays allowed', async () => {
    const task = await worktreeTask()
    cooldowns.set('glm-flash', FUTURE)
    const answer = await preview(task.id, 'devs', 'zai')
    expect(answer).toMatchObject({
      profile: 'glm-flash',
      spawn: { allowed: false, profile: 'glm-flash', blockedBy: `worker zai (glm-flash) is cooling until ${FUTURE}` },
      warning: `Worker zai is cooling until ${FUTURE}; the instruction waits until then`,
      worker: { selector: 'zai', profiles: ['glm-flash'], cooldownUntil: FUTURE },
    })
    // Without the choice the cooling profile is skipped, as before.
    expect(await preview(task.id, 'devs')).toMatchObject({ profile: 'sonnet', spawn: { allowed: true }, warning: null })
    const outcome = await assignments.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' },
      instruction: 'Build the export', requestKey: 'assign-1', worker: 'zai' })
    expect(outcome.message).toMatchObject({ state: 'queued', workerChoice: 'zai' })
  })

  test('a choice whose workers are at their caps names them', async () => {
    const task = await worktreeTask()
    member('glm', { groupId: 'capped', claudeProfileId: 'glm-flash', projectPath: path.join(dir, 'b') })
    expect((await preview(task.id, 'capped', 'zai')).spawn).toEqual({ allowed: false, profile: null, blockedBy: 'every profile of worker zai (glm-flash) is at its cap' })
  })

  test('a waiting member that is parked or context-exhausted is not listed as idle', async () => {
    const task = await worktreeTask()
    member('ready')
    member('parked')
    member('exhausted', { contextExhausted: { at: '2026-10-22T00:00:00.000Z', reason: 'prompt_too_long' } })
    const held = mail.enqueue({ teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'human', fromSession: null, fromGroup: null,
      originPath: dir, priority: 'normal', body: 'parked work' })
    db.db.prepare("UPDATE team_messages SET state = 'parked', claimed_by = 'parked' WHERE id = ?").run(held.id)
    expect((await preview(task.id, 'devs')).idleMembers).toEqual(['ready'])
    expect((await preview(task.id, 'devs', 'claude')).idleMembers).toEqual(['ready'])
  })

  test('one pending spawn on a capped profile is counted once', async () => {
    const task = await worktreeTask()
    pendingSpawn('pair', 'sonnet')
    // sonnet: 1 pending of 2 — counted twice it would read full and fall to glm-flash.
    expect((await preview(task.id, 'pair', 'claude')).profile).toBe('sonnet')
    expect((await preview(task.id, 'pair')).profile).toBe('sonnet')
  })

  test('one pending spawn fills a cap-1 profile, so no spawn is claimed', async () => {
    const task = await worktreeTask()
    pendingSpawn('solo', 'sonnet')
    // sonnet: 1 pending of 1 — dropped, the preview would claim a spawn while dispatch waits on the cap.
    expect((await preview(task.id, 'solo')).spawn).toEqual({ allowed: false, profile: null, blockedBy: 'every allowed profile is at its cap or cooling down' })
    expect((await preview(task.id, 'solo')).profile).toBeNull()
    expect((await preview(task.id, 'solo', 'claude')).spawn).toEqual({ allowed: false, profile: null, blockedBy: 'every profile of worker claude (sonnet) is at its cap' })
  })

  test('a session target with a worker is refused, as dispatch refuses it', async () => {
    const task = await worktreeTask()
    member('dev')
    await expect(assignments.preview(human(), { taskId: task.id, target: { kind: 'session', id: 'dev' }, worker: 'claude' }))
      .rejects.toThrow(WORKER_GROUP_TARGET_ONLY)
  })
})

describe('the group preview shows the policy a spawn gets (team-approval-default O3, O6)', () => {
  // @covers: task-assignment › Dispatch can be previewed before sending › Group preview shows the resolved policy and its source
  test('O3: no group key under an auto team default previews auto from the team default', async () => {
    staffing.approvalDefaults.set('team', 'auto')
    const shown = await preview((await worktreeTask()).id, 'devs')
    expect({ approval: shown.approval, approvalSource: shown.approvalSource }).toEqual({ approval: 'auto', approvalSource: 'team' })
  })

  // @covers: task-assignment › Dispatch can be previewed before sending › Group preview names a group key over the default
  test('O6: an explicit manual group key wins over an auto team default', async () => {
    staffing.approvalDefaults.set('team', 'auto')
    const shown = await preview((await worktreeTask()).id, 'strict')
    expect({ approval: shown.approval, approvalSource: shown.approvalSource }).toEqual({ approval: 'manual', approvalSource: 'group' })
  })
})
