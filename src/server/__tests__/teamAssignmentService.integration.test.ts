// Assignment service (task-assignment 3.1–3.4): dispatch as one committed
// pair (assignment row + human-originated instruction mail), request-key
// idempotency across every replay path, explicit reassignment with
// cancel-on-stop and notify, and the read-only dispatch preview.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { PlanStore } from '../plans/planStore'
import { normalizePlanContent } from '../../shared/plans'
import { planInput } from '../../shared/__tests__/planFixtures'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { recordRecipient } from './helpers/recordRecipient'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let feature: string
let other: string
let home: string
let team: TeamIdentity
let db: SessionDatabase
let mail: MailboxStore
let assignments: AssignmentStore
let taskStore: TaskStore
let service: TaskService
let dispatcher: AssignmentService
let records: Map<string, ChatSessionRecord>
let cooldowns: Map<string, string>
const human = (): TaskCaller => ({ kind: 'human', team })

const writeGroup = (id: string, content: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), content)
}
const row = (sessionId: string, groupId: string | null, projectPath = repo, extra: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '', ...extra,
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-assignment-service-')))
  repo = path.join(root, 'repo')
  feature = path.join(root, 'repo-feature')
  other = path.join(root, 'other')
  home = path.join(root, 'home')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'add-export'), { recursive: true })
  fs.mkdirSync(path.join(feature, 'openspec', 'changes', 'branch-only'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'archive'), { recursive: true })
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs', '---\nlabel: Developers\nmax: 3\n---\nBuild features')
  writeGroup('leads', '---\nlabel: Team leads\n---\nCoordinate work')
  records = new Map([
    ['dev-main', row('dev-main', 'devs', repo)],
    ['dev-feature', row('dev-feature', 'devs', feature)],
    ['solo', row('solo', null)],
    ['stranger', row('stranger', 'devs', other)],
  ])
  cooldowns = new Map()
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(db.db, { recipientExists: id => records.has(id) })
  const caps = new TeamCaps({ homeDir: home })
  const worktrees = new TeamWorktrees()
  assignments = new AssignmentStore(db.db, mail)
  taskStore = new TaskStore(db.db, mail, assignments)
  service = new TaskService(taskStore, { getSession: id => records.get(id), homeDir: home })
  // The team of a record's project path, as SessionTeams resolves it: the
  // repository shares one team, the other repository is a stranger.
  const teamOf = (id: string) => {
    const record = records.get(id)
    return record && record.projectPath !== other ? team : undefined
  }
  const staffing = new WorktreeStaffing(db.db, mail, {
    records: () => records.values(),
    teamOf,
    caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  dispatcher = new AssignmentService(db.db, assignments, taskStore, mail, {
    getSession: id => records.get(id),
    records: () => records.values(),
    teamOf,
    staffing, caps, worktrees, homeDir: home, plans: new PlanStore(db.db),
    cooldownUntil: profileId => cooldowns.get(profileId) ?? null,
    recipient: id => recordRecipient(records.get(id), team.teamId, mail),
  })
})

describe('dispatch', () => {
  test('a group dispatch commits the assignment and its instruction mail together', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const outcome = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Please build the export', requestKey: 'k1',
    })
    expect(outcome.replay).toBe(false)
    expect(outcome.assignment).toMatchObject({
      taskId: task.id, targetKind: 'group', targetId: 'devs', role: 'devs', state: 'queued',
      claimedBy: null, createdBy: { kind: 'human', sessionId: null },
    })
    expect(outcome.message).toMatchObject({
      fromKind: 'human', fromSession: null, fromGroup: null, originPath: repo,
      toKind: 'group', toId: 'devs', priority: 'normal', state: 'queued', taskId: task.id,
      body: 'Please build the export',
    })
    // The pair is visible through the task record immediately.
    expect(taskStore.list(team.teamId)[0]!.assignment!.id).toBe(outcome.assignment.id)
    expect(taskStore.journal(task.id).map(entry => entry.text)).toEqual(['Assigned to group devs by human'])
  })

  test('a session dispatch targets the member and records its group as the role', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const outcome = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'dev-feature' }, instruction: 'Go', requestKey: 'k2',
    })
    expect(outcome.assignment).toMatchObject({ targetKind: 'session', targetId: 'dev-feature', role: 'devs', state: 'queued' })
    expect(outcome.message).toMatchObject({ toKind: 'session', toId: 'dev-feature' })
  })

  test('refusals write nothing: empty instruction, unknown group, archived or other-team session', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: '   ', requestKey: 'k3',
    })).rejects.toThrow('instruction')
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'ghosts' }, instruction: 'Go', requestKey: 'k3',
    })).rejects.toThrow('Unknown group')
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'ghost' }, instruction: 'Go', requestKey: 'k3',
    })).rejects.toThrow('Unknown session')
    records.set('archived', row('archived', 'devs', repo, { archivedAt: '2026-10-13T00:00:00.000Z' }))
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'archived' }, instruction: 'Go', requestKey: 'k3',
    })).rejects.toThrow('archived')
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'stranger' }, instruction: 'Go', requestKey: 'k3',
    })).rejects.toThrow('another team')
    await expect(dispatcher.dispatch(human(), {
      taskId: 'task-elsewhere', target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k3',
    })).rejects.toThrow('not found in this team')
    expect(assignments.listByTask(task.id)).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
    expect(taskStore.journal(task.id)).toEqual([])
  })

  test('a context-exhausted session target is refused, naming the flag, and nothing is written', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const flag = { at: '2026-10-18T09:00:00.000Z', reason: 'blocking_limit' as const }
    records.set('dev-feature', { ...records.get('dev-feature')!, contextExhausted: flag })
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'dev-feature' }, instruction: 'Go', requestKey: 'k-flag',
    })).rejects.toThrow(`Session dev-feature's context is exhausted (blocking_limit, since ${flag.at})`)
    await expect(dispatcher.preview(human(), { taskId: task.id, target: { kind: 'session', id: 'dev-feature' } }))
      .rejects.toThrow('context is exhausted')
    expect(assignments.listByTask(task.id)).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })

  test('a session flagged while the team is resolved is refused: the flag is read after the last await', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const clean = records.get('dev-feature')!
    const get = records.get.bind(records)
    let reads = 0
    // The first read precedes resolveTeam's await; every later read sees the flag set meanwhile.
    records.get = (id: string) => (id === 'dev-feature' && reads++ > 0
      ? { ...clean, contextExhausted: { at: '2026-10-18T09:00:00.000Z', reason: 'prompt_too_long' } }
      : get(id))
    try {
      await expect(dispatcher.dispatch(human(), {
        taskId: task.id, target: { kind: 'session', id: 'dev-feature' }, instruction: 'Go', requestKey: 'k-race',
      })).rejects.toThrow('context is exhausted')
    } finally { records.get = get }
    expect(assignments.listByTask(task.id)).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
  })
})

describe('request-key idempotency', () => {
  test('a double dispatch sends one instruction and returns the first assignment', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const input = { taskId: task.id, target: { kind: 'group' as const, id: 'devs' }, instruction: 'Go', requestKey: 'intent-9' }
    const first = await dispatcher.dispatch(human(), input)
    const second = await dispatcher.dispatch(human(), input)
    expect(second.replay).toBe(true)
    expect(second.assignment.id).toBe(first.assignment.id)
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('the same key aimed at a different task is refused naming the task', async () => {
    const first = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const second = await service.create(human(), { title: 'Other', direction: 'd' })
    await dispatcher.dispatch(human(), { taskId: first.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'cross-task' })
    await expect(dispatcher.dispatch(human(), {
      taskId: second.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'cross-task',
    })).rejects.toThrow('different task')
    expect(assignments.listByTask(second.id)).toEqual([])
  })

  test('the same key with a different target or instruction is refused; the original stands', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    await dispatcher.dispatch(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'intent-9' })
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Different', requestKey: 'intent-9',
    })).rejects.toThrow('different instruction')
    await expect(dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'session', id: 'solo' }, instruction: 'Go', requestKey: 'intent-9',
    })).rejects.toThrow('different target')
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('create is idempotent under its key: one task after a replay, never two', async () => {
    const input = { title: 'Export', direction: 'CSV', requestKey: 'create-1' }
    const first = await service.create(human(), input)
    const replay = await service.create(human(), input)
    expect(replay.id).toBe(first.id)
    expect(taskStore.list(team.teamId)).toHaveLength(1)
  })

  test('create succeeded, dispatch refused, retry on the same task sends exactly one instruction', async () => {
    const created = await service.create(human(), { title: 'Export', direction: 'CSV', requestKey: 'intent-7' })
    // The dispatch leg fails (unknown group); the create stands.
    await expect(dispatcher.dispatch(human(), {
      taskId: created.id, target: { kind: 'group', id: 'ghosts' }, instruction: 'Go', requestKey: 'intent-7',
    })).rejects.toThrow('Unknown group')
    expect(taskStore.list(team.teamId)).toHaveLength(1)
    const retried = await dispatcher.dispatch(human(), {
      taskId: created.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'intent-7',
    })
    expect(retried.assignment.taskId).toBe(created.id)
    expect(mail.forTask(created.id)).toHaveLength(1)
    expect(taskStore.list(team.teamId)).toHaveLength(1)
  })

  test('the owner becomes visible after the dispatcher claims the instruction', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const { assignment } = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k-claim',
    })
    mail.claim(assignment.messageId!, 'dev-main')
    expect(taskStore.list(team.teamId)[0]!.assignment).toMatchObject({ state: 'claimed', claimedBy: 'dev-main' })
  })

  test('a dead-lettered instruction fails its assignment and the task can be reassigned without handling', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const first = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey: 'k-dead',
    })
    mail.deadLetter(first.assignment.messageId!, 'worktree-missing: /gone')
    // The history shows the failure with its reason; no assignment is outstanding.
    expect(taskStore.detail(task.id)!.assignments[0]).toMatchObject({ state: 'failed', reason: 'worktree-missing: /gone' })
    expect(taskStore.list(team.teamId)[0]!.assignment).toBeNull()
    // Failed is not outstanding: no handling choice is required.
    const second = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Try leads', requestKey: 'k-next',
    })
    expect(second.assignment.targetId).toBe('leads')
    const rows = assignments.listByTask(task.id)
    expect(rows.map(row => row.state)).toEqual(['failed', 'queued'])
  })
})

describe('reassignment', () => {
  const setup = async (requestKey: string) => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV' })
    const first = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'devs' }, instruction: 'Go', requestKey,
    })
    return { task, first }
  }

  test('a new dispatch onto an outstanding assignment is refused without handling, naming it', async () => {
    const { task, first } = await setup('r1')
    const refusal = dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r1-next',
    })
    await expect(refusal).rejects.toThrow('outstanding assignment: group devs, queued')
    // Nothing was written: one assignment, one instruction.
    expect(assignments.listByTask(task.id).map(row => row.id)).toEqual([first.assignment.id])
    expect(mail.forTask(task.id)).toHaveLength(1)
  })

  test('stop supersedes and cancels a queued instruction; the recipient is untouched', async () => {
    const { task, first } = await setup('r2')
    const second = await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r2-next', handling: 'stop',
    })
    expect(mail.get(first.assignment.messageId!)!.state).toBe('cancelled')
    expect(assignments.listByTask(task.id).map(row => [row.targetId, row.state])).toEqual([['devs', 'superseded'], ['leads', 'queued']])
    expect(second.assignment.state).toBe('queued')
    expect(taskStore.journal(task.id).map(entry => entry.text)).toEqual([
      'Assigned to group devs by human',
      'Assigned to group leads by human',
      'Assignment to group devs superseded by reassignment (stop)',
    ])
  })

  test('stop after delivery leaves the delivered instruction and its recipient alone', async () => {
    const { task, first } = await setup('r3')
    mail.claim(first.assignment.messageId!, 'dev-main')
    mail.markPushed(first.assignment.messageId!)
    mail.markDelivered(first.assignment.messageId!)
    await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r3-next', handling: 'stop',
    })
    expect(mail.get(first.assignment.messageId!)!.state).toBe('delivered')
    expect(assignments.listByTask(task.id)[0]).toMatchObject({ state: 'superseded', claimedBy: 'dev-main' })
  })

  test('a spawning reservation is left to staffing: stop supersedes without cancelling it', async () => {
    const { task, first } = await setup('r4')
    mail.reserveForSpawn(first.assignment.messageId!)
    await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r4-next', handling: 'stop',
    })
    expect(mail.get(first.assignment.messageId!)!.state).toBe('spawning')
    expect(assignments.listByTask(task.id)[0]!.state).toBe('superseded')
  })

  test('stop cancels an instruction held for a pending request', async () => {
    const { task, first } = await setup('r4b')
    mail.holdForRequest(first.assignment.messageId!)
    await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r4b-next', handling: 'stop',
    })
    expect(mail.get(first.assignment.messageId!)!.state).toBe('cancelled')
  })

  test('notify sends the claimed agent a direct note; without a claim it is a plain supersede', async () => {
    const { task, first } = await setup('r5')
    mail.claim(first.assignment.messageId!, 'dev-main')
    await dispatcher.dispatch(human(), {
      taskId: task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r5-next', handling: 'notify',
    })
    const notes = mail.forTask(task.id).filter(row => row.toKind === 'session' && row.toId === 'dev-main')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ fromKind: 'human', priority: 'normal', state: 'queued' })
    expect(notes[0]!.body).toContain('was reassigned to group leads')
    expect(notes[0]!.body).toContain('your work is not cancelled')
    expect(assignments.listByTask(task.id)[0]!.state).toBe('superseded')
    // Notify without a claim degrades: supersede only, no note.
    const plain = await setup('r6')
    await dispatcher.dispatch(human(), {
      taskId: plain.task.id, target: { kind: 'group', id: 'leads' }, instruction: 'Redo', requestKey: 'r6-next', handling: 'notify',
    })
    expect(mail.forTask(plain.task.id).filter(row => row.toKind === 'session')).toHaveLength(0)
    expect(assignments.listByTask(plain.task.id)[0]!.state).toBe('superseded')
  })

  test('a same-key replay of a reassignment returns the completed outcome without repeating it', async () => {
    const { task, first } = await setup('r7')
    const input = {
      taskId: task.id, target: { kind: 'group' as const, id: 'leads' }, instruction: 'Redo', requestKey: 'r7-next', handling: 'stop' as const,
    }
    const first_ = await dispatcher.dispatch(human(), input)
    const replay = await dispatcher.dispatch(human(), input)
    expect(replay.replay).toBe(true)
    expect(replay.assignment.id).toBe(first_.assignment.id)
    expect(mail.forTask(task.id)).toHaveLength(2) // instruction + replacement, never two replacements
    expect(mail.get(first.assignment.messageId!)!.state).toBe('cancelled')
    expect(assignments.listByTask(task.id)).toHaveLength(2)
  })
})

describe('preview', () => {
  // @covers: task-assignment › Dispatch can be previewed before sending › Group preview shows staffing availability
  test('a group preview for a worktree task names idle matching members and the spawn profile', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    const preview = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' } })
    expect(preview).toMatchObject({
      worktree: feature, target: { kind: 'group', id: 'devs' }, role: 'Developers', approval: 'manual',
      sessionWorktree: null, idleMembers: ['dev-feature'], warning: null,
    })
    expect(preview.spawn.allowed).toBe(true)
    expect(preview.spawn.profile).toBe('default')
    expect(preview.profile).toBe('default')
  })

  test('an idle main-checkout member never matches the worktree; the preview says so', async () => {
    records.delete('dev-feature')
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    const preview = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' } })
    expect(preview.idleMembers).toEqual([])
    expect(preview.spawn.allowed).toBe(true)
  })

  test('spawn is blocked when the group is at its max, and the reason names the cap', async () => {
    writeGroup('tiny', '---\nlabel: Tiny\nmax: 1\n---\nOne only')
    records.set('tiny-1', row('tiny-1', 'tiny', repo))
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    const preview = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'group', id: 'tiny' } })
    expect(preview.spawn.allowed).toBe(false)
    expect(preview.spawn.blockedBy).toContain('max of 1')
  })

  test('a cooling profile is skipped when choosing the spawn profile', async () => {
    writeGroup('routed', '---\nlabel: Routed\nprofiles: [glm, kimi]\n---\nRoute')
    cooldowns.set('glm', new Date(Date.now() + 3_600_000).toISOString())
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    const preview = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'group', id: 'routed' } })
    expect(preview.profile).toBe('kimi')
    expect(preview.spawn.profile).toBe('kimi')
  })

  // @covers: task-assignment › Dispatch can be previewed before sending › Session preview shows profile and policy
  // @covers: task-assignment › Dispatch can be previewed before sending › Worktree mismatch is warned, not blocked
  test('a session preview shows its worktree, profile, and approval, and warns on mismatch without blocking', async () => {
    records.set('glmer', row('glmer', 'devs', repo, { claudeProfileId: 'glm', approvalPolicy: 'auto' }))
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    const preview = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'session', id: 'glmer' } })
    expect(preview).toMatchObject({
      sessionWorktree: repo, profile: 'glm', approval: 'auto', role: null, idleMembers: [],
    })
    expect(preview.warning).toContain(repo)
    expect(preview.warning).toContain(feature)
    // Dispatch stays allowed (ruled 2026-10-13: warn but allow).
    const outcome = await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'session', id: 'glmer' } })
    expect(outcome.warning).not.toBeNull()
  })

  test('a form worktree resolves through the same server rules; an unknown one is refused', async () => {
    const ok = await dispatcher.preview(human(), { worktree: feature, target: { kind: 'group', id: 'devs' } })
    expect(ok.worktree).toBe(feature)
    await expect(dispatcher.preview(human(), { worktree: '/nope', target: { kind: 'group', id: 'devs' } }))
      .rejects.toThrow('is not a worktree of this team')
  })

  test('preview performs no writes and no spawn reservations', async () => {
    const task = await service.create(human(), { title: 'Export', direction: 'CSV', worktree: feature })
    await dispatcher.preview(human(), { taskId: task.id, target: { kind: 'group', id: 'devs' } })
    expect(assignments.listByTask(task.id)).toEqual([])
    expect(mail.forTask(task.id)).toEqual([])
    expect(mail.spawningRows()).toEqual([])
    expect((db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get() as { n: number }).n).toBe(0)
  })
})

describe('targets', () => {
  test('worktrees come with branches; changes list the roots validateChange accepts', async () => {
    const targets = await dispatcher.targets(human())
    const paths = targets.worktrees.map(entry => entry.root)
    expect(paths).toContain(repo)
    expect(paths).toContain(feature)
    const main = targets.worktrees.find(entry => entry.root === repo)!
    const linked = targets.worktrees.find(entry => entry.root === feature)!
    expect(['master', 'main']).toContain(main.branch ?? '')
    expect(linked.branch).toBe('feature')
    // Without a chosen worktree only the main checkout's changes are listed
    // — the worktree-only one would be refused by validateChange.
    expect(targets.changes.map(change => change.name)).toEqual(['add-export'])
    expect(targets.changes[0]!.locations).toEqual([repo])
    expect(targets.changes.map(change => change.name)).not.toContain('archive')
  })

  test('a change that lives only in worktree W is listed iff W is the chosen worktree', async () => {
    const narrowed = await dispatcher.targets(human(), feature)
    const names = narrowed.changes.map(change => change.name)
    expect(names).toContain('branch-only')
    expect(narrowed.changes.find(change => change.name === 'branch-only')!.locations).toEqual([feature])
    expect(names).toContain('add-export')
    const main = await dispatcher.targets(human(), repo)
    expect(main.changes.map(change => change.name)).toEqual(['add-export'])
    await expect(dispatcher.targets(human(), path.join(root, 'nope'))).rejects.toThrow('is not a worktree')
  })

  test('plans: only open plans with an approved revision, with that revision\'s change names', async () => {
    const plans = new PlanStore(db.db)
    const add = (title: string, approve: boolean) => {
      const id = plans.insertPlan({ teamId: team.teamId, title, creator: { kind: 'human', sessionId: null } })
      plans.insertRevision(id, { content: normalizePlanContent(planInput()), contentHash: 'h', pin: null, author: { kind: 'human', sessionId: null } })
      if (approve) { plans.setRevisionStatus(id, 1, 'approved'); plans.setCurrentApproved(id, 1) }
      return id
    }
    const approved = add('Approved', true)
    add('In review', false)
    plans.setLifecycle(add('Closed', true), 'cancelled')
    expect((await dispatcher.targets(human())).plans).toEqual([{ id: approved, title: 'Approved', revision: 1, changes: ['api', 'ui'] }])
  })
})
