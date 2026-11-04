// Worktree staffing (team-tasks D4/D6, profile-routing D4a): worktree-filtered
// pickup, the caps (group max, per-profile, team, worktree writer) with
// durable reservations, spawn failure and restart reconciliation, and
// dead-lettering mail for a removed worktree — never creating one. Spawns
// are driven the production way: the profile router over due group mail.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailDispatcher, type EligibleMember, type MailRecipient, type SpawnAssignment } from '../team/dispatcher'
import { ProfileRouter } from '../team/routing/router'
import { loadTeamGroups } from '../team/teamGroups'
import { MailboxStore } from '../team/mailboxStore'
import { WorktreeStaffing, type SpawnRequest, type SpawnResult } from '../team/staffing'
import { TaskStore } from '../team/taskStore'
import { TeamCaps, teamCapsFile } from '../team/teamCaps'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { TeamWorktrees, worktreeRootOf } from '../team/worktreeRoots'
import { previewGroupDispatch } from '../team/groupDispatchPreview'
import { memberRows } from '../team/workspaceRead'
import { resolveSpawnApproval } from '../../shared/spawnApproval'

function git(args: string[], cwd?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

let root: string
let repo: string
let featX: string
let featY: string
let team: TeamIdentity

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-staffing-')))
  repo = path.join(root, 'repo')
  featX = path.join(root, 'feat-x')
  featY = path.join(root, 'feat-y')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-x', featX], repo)
  git(['worktree', 'add', '-q', '-b', 'feat-y', featY], repo)
  fs.mkdirSync(path.join(featX, 'src'), { recursive: true })
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let dir: string
let home: string
let db: SessionDatabase
let store: MailboxStore
let tasks: TaskStore
let records: Map<string, ChatSessionRecord>
/** Sessions the router sees as idle and eligible (they must also be records). */
let idleMembers: string[]
let spawned: SpawnRequest[]
let spawnFails: string | null
let staffing: WorktreeStaffing
let clock: number

const writeGroup = (id: string, frontmatter: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), `---\n${frontmatter}\n---\nWork.`)
}
const record = (sessionId: string, extra: Partial<ChatSessionRecord>): ChatSessionRecord => ({
  sessionId, name: sessionId, projectPath: repo, sdkSessionId: null, status: 'working', createdAt: '', lastActivityAt: '', groupId: 'devs', ...extra,
})
const makeStaffing = (onError?: (error: unknown) => void, extra: { retryAfterMs?: number; onSpawnBackoff?: (message: { id: string; state: string }, retryAt: number) => void } = {}) =>
  new WorktreeStaffing(db.db, store, {
    records: () => records.values(),
    teamOf: () => team,
    caps: new TeamCaps({ homeDir: home }),
    worktrees: new TeamWorktrees({ ttlMs: 0 }),
    ...(onError ? { onError } : {}),
    ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    ...(extra.onSpawnBackoff ? { onSpawnBackoff: extra.onSpawnBackoff } : {}),
    now: () => clock,
    spawn: async (request): Promise<SpawnResult> => {
      spawned.push(request)
      if (spawnFails) return { ok: false, error: spawnFails }
      const sessionId = `spawned-${spawned.length}`
      records.set(sessionId, record(sessionId, {
        projectPath: request.projectPath, groupId: request.groupId, spawned: true, taskId: request.taskId, status: 'waiting',
        ...(request.profileId ? { claudeProfileId: request.profileId } : {}),
      }))
      return { ok: true, sessionId }
    },
  })
const targetWorktree = (message: { taskId: string | null }) => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null)
const makeRouter = (staff: WorktreeStaffing) => new ProfileRouter({
  groupOf: async message => (await loadTeamGroups(repo, home)).catalog.groups.get(message.toId ?? '')?.group,
  members: (_teamId, groupId) => [...records.values()]
    .filter(row => row.archivedAt == null && row.groupId === groupId)
    .map(row => ({ sessionId: row.sessionId, profileId: row.claudeProfileId ?? 'default', cwd: row.projectPath })),
  targetWorktree,
  staffing: staff, rules: { rule: () => undefined }, limits: { forProfile: () => [], forProvider: () => [], cooldownFor: () => ({ until: null, provider: false, providerId: null }), providerCooldownUntil: () => null }, usageOf: () => null, providerUsageOf: () => null,
  now: () => clock,
})
/** One routing pass over due group mail; the members spawned and the mail reserved for them. */
const pass = async (staff: WorktreeStaffing = staffing): Promise<SpawnAssignment[]> => {
  const router = makeRouter(staff)
  const assignments: SpawnAssignment[] = []
  for (const message of store.dueGroupMail()) {
    const eligible: EligibleMember[] = idleMembers.flatMap(id => {
      const row = records.get(id)
      return row && worktreeRootOf(row.projectPath) === targetWorktree(message) ? [{
        sessionId: id, teamId: team.teamId, groupId: row.groupId ?? null, idle: true, pendingRequest: false, available: true,
        worktree: worktreeRootOf(row.projectPath), idleForMs: 1,
      }] : []
    })
    const result = await router.route(message, { eligible, attempt: 0 })
    if (result.kind === 'spawned') assignments.push(result.assignment)
  }
  return assignments
}
const task = (worktree: string | null) => tasks.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null }, worktree })
const mail = (taskId: string | null, extra: Partial<Parameters<MailboxStore['enqueue']>[0]> = {}) => store.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: 'leads', originPath: repo, body: 'work', taskId, ...extra,
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(dir, 'home')
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('devs', 'max: 3\nprofile: glm\napproval: auto')
  writeGroup('qa', 'max: 2')
  db = initDatabase({ path: path.join(dir, 'db.sqlite') })
  store = new MailboxStore(db.db)
  tasks = new TaskStore(db.db, store)
  records = new Map([['lead', record('lead', { groupId: 'leads' })]])
  idleMembers = []
  spawned = []
  spawnFails = null
  clock = 1_000_000
  staffing = makeStaffing()
})
afterEach(() => db.close())

describe('spawning', () => {
  // @covers: team-worktree-staffing › A member is spawned when none is available › Spawn for an unstaffed worktree
  // @covers: team-worktree-staffing › A member is spawned when none is available › Group settings applied
  test('an unstaffed worktree gets a member with the group settings and the message reserved for it', async () => {
    const t = task(featX)
    const m = mail(t.id)
    const assignments = await pass()
    expect(spawned).toEqual([{ projectPath: featX, groupId: 'devs', profileId: 'glm', approvalPolicy: 'auto', taskId: t.id }])
    expect(assignments).toEqual([{ message: expect.objectContaining({ id: m.id, state: 'spawning' }), sessionId: 'spawned-1' }])
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
  })

  test('group defaults: default profile and manual approval', async () => {
    writeGroup('devs', 'max: 1')
    mail(task(featX).id)
    await pass()
    expect(spawned[0]).toEqual({ projectPath: featX, groupId: 'devs', approvalPolicy: 'manual', taskId: expect.any(String) })
  })

  test('an idle member already in the worktree takes the mail: no spawn', async () => {
    records.set('dev-x', record('dev-x', { projectPath: featX, status: 'waiting' }))
    idleMembers.push('dev-x')
    mail(task(featX).id)
    expect(await pass()).toEqual([])
    expect(spawned).toEqual([])
  })

  test('mail without a task, or whose task has no worktree, or direct mail is never staffed', async () => {
    mail(null)
    mail(task(null).id)
    mail(task(featX).id, { toKind: 'session', toId: 'lead' })
    expect(await pass()).toEqual([])
    expect(spawned).toEqual([])
  })
})

describe('spawn approval resolution (team-approval-default O1–O9, L2)', () => {
  type Row = [id: string, groupKey: 'manual' | 'auto' | null, teamDefault: 'manual' | 'auto' | null, policy: 'manual' | 'auto']
  // | id | group key | team default | policy |
  const TABLE: Row[] = [
    ['O1', null, null, 'manual'],
    ['O2', null, 'manual', 'manual'],
    ['O3', null, 'auto', 'auto'],
    ['O4', 'manual', null, 'manual'],
    ['O5', 'manual', 'manual', 'manual'],
    ['O6', 'manual', 'auto', 'manual'],
    ['O7', 'auto', null, 'auto'],
    ['O8', 'auto', 'manual', 'auto'],
    ['O9', 'auto', 'auto', 'auto'],
  ]
  for (const [id, groupKey, teamDefault, policy] of TABLE) {
    // @covers: team-worktree-staffing › A member is spawned when none is available › Neither set keeps manual
    // @covers: team-worktree-staffing › A member is spawned when none is available › Team default applies to a group without the key
    // @covers: team-worktree-staffing › A member is spawned when none is available › Explicit manual beats an auto default
    // @covers: team-worktree-staffing › A member is spawned when none is available › Explicit auto beats a manual default
    test(`${id}: group ${groupKey ?? 'absent'} × team ${teamDefault ?? 'none'} spawns ${policy}`, async () => {
      writeGroup('devs', groupKey === null ? 'max: 1' : `max: 1\napproval: ${groupKey}`)
      if (teamDefault !== null) staffing.approvalDefaults.set(team.teamId, teamDefault)
      mail(task(featX).id)
      await pass()
      expect(spawned).toHaveLength(1)
      expect(spawned[0]!.approvalPolicy).toBe(policy)
    })
  }

  // @covers: team-worktree-staffing › A team has a default approval policy for spawned members › Defaults are per team
  test('L2: another team’s default never reaches this team’s spawn', async () => {
    writeGroup('devs', 'max: 1')
    staffing.approvalDefaults.set('/elsewhere/.git', 'auto')
    mail(task(featX).id)
    await pass()
    expect(spawned[0]!.approvalPolicy).toBe('manual')
  })

  test('the default is read at each spawn: a change reaches the next spawn only', async () => {
    writeGroup('devs', 'max: 3')
    mail(task(featX).id)
    await pass()
    staffing.approvalDefaults.set(team.teamId, 'auto')
    mail(task(featY).id)
    await pass()
    expect(spawned.map(request => request.approvalPolicy)).toEqual(['manual', 'auto'])
  })
})

describe('G1: spawn, preview, and Members agree on the policy (team-approval-default)', () => {
  /** mulberry32: a fixed-seed generator, no dependency. */
  const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const KEYS = [null, 'manual', 'auto'] as const

  test('200 seeded cases: every reader equals resolveSpawnApproval', async () => {
    // The design's seam: an in-memory database, so 400 writes do not wait on
    // file syncs (the case's file database is replaced and closed by afterEach).
    db.close()
    db = initDatabase({ path: ':memory:' })
    store = new MailboxStore(db.db)
    tasks = new TaskStore(db.db, store)
    staffing = makeStaffing()
    const random = mulberry32(0x7a11)
    const seen = new Set<string>()
    // One parsed catalog per group-key variant, read through the real loader.
    const catalogs = new Map<string, Awaited<ReturnType<typeof loadTeamGroups>>['catalog']>()
    for (const key of KEYS) {
      writeGroup('devs', key === null ? 'max: 1' : `max: 1\napproval: ${key}`)
      catalogs.set(String(key), (await loadTeamGroups(repo, home)).catalog)
    }
    // One task carries every case's message: task writes are not what G1 tests.
    const shared = task(featX)
    for (let i = 0; i < 200; i++) {
      const groupKey = KEYS[Math.floor(random() * 3)]!
      const teamDefault = KEYS[Math.floor(random() * 3)]!
      seen.add(`${groupKey}/${teamDefault}`)
      db.db.prepare('DELETE FROM team_approval_defaults').run()
      if (teamDefault !== null) staffing.approvalDefaults.set(team.teamId, teamDefault)
      // Each case starts unstaffed, so the spawn's caps never decide the outcome.
      for (const id of records.keys()) if (id !== 'lead') records.delete(id)
      spawned = []
      const catalog = catalogs.get(String(groupKey))!
      const group = catalog.groups.get('devs')!.group
      const expected = resolveSpawnApproval(group.approval, teamDefault)
      const message = mail(shared.id)
      expect(await staffing.spawnFor(store.get(message.id)!, featX, group, 'default')).not.toBeNull()
      const preview = previewGroupDispatch({
        worktree: featX, target: { kind: 'group', id: 'devs' }, group, members: [], recipient: () => undefined,
        facts: { liveOnProfile: {}, pendingProfiles: [], groupMembers: 0, teamSpawned: 0, worktreeWriters: 0 },
        teamCap: 5, providerOf: id => id, cooldownUntil: () => null, workerChoice: null,
        teamDefault: staffing.approvalDefaults.get(team.teamId), now: clock,
      })
      const row = memberRows(catalog, [], () => ({}), staffing.approvalDefaults.get(team.teamId)).find(entry => entry.id === 'devs')!
      const label = `case ${i}: group ${groupKey ?? 'absent'} × team ${teamDefault ?? 'none'}`
      expect({ label, spawn: spawned[0]!.approvalPolicy }).toEqual({ label, spawn: expected.policy })
      expect({ label, approval: preview.approval, source: preview.approvalSource }).toEqual({ label, approval: expected.policy, source: expected.source })
      expect({ label, approval: row.approval, source: row.approvalSource }).toEqual({ label, approval: expected.policy, source: expected.source })
    }
    // The seed reaches every row of the table.
    expect(seen.size).toBe(9)
  })
})

describe('caps', () => {
  test('group max counts every live member, spawned or not; the message waits', async () => {
    writeGroup('devs', 'max: 2')
    records.set('dev-1', record('dev-1', { projectPath: featY }))
    records.set('dev-2', record('dev-2', { projectPath: repo }))
    const m = mail(task(featX).id)
    expect(await pass()).toEqual([])
    expect(store.get(m.id)?.state).toBe('queued')
    // Archiving a member frees its slot; the next pass spawns.
    records.get('dev-2')!.archivedAt = '2026-10-11'
    expect(await pass()).toHaveLength(1)
  })

  test('one spawned writer per worktree, even busy in a subdirectory, and of another group', async () => {
    records.set('writer', record('writer', { projectPath: path.join(featX, 'src'), spawned: true, groupId: 'qa' }))
    const m = mail(task(featX).id)
    expect(await pass()).toEqual([])
    expect(store.get(m.id)?.state).toBe('queued')
    // A manually created (not spawned) member in the worktree does not hold the writer slot.
    records.get('writer')!.spawned = false
    expect(await pass()).toHaveLength(1)
  })

  test('a second message for a staffed worktree waits for the spawned member', async () => {
    const t = task(featX)
    mail(t.id)
    const second = mail(t.id)
    const assignments = await pass()
    expect(assignments).toHaveLength(1)
    expect(spawned).toHaveLength(1)
    expect(store.get(second.id)?.state).toBe('queued')
  })

  test('the team spawn cap from ~/.kawai/teams.json bounds spawned sessions; killing one frees a slot', async () => {
    fs.mkdirSync(path.dirname(teamCapsFile(home)), { recursive: true })
    fs.writeFileSync(teamCapsFile(home), JSON.stringify({ maxSpawnedSessions: 1 }))
    mail(task(featX).id)
    const waiting = mail(task(featY).id)
    expect(await pass()).toHaveLength(1)
    expect(store.get(waiting.id)?.state).toBe('queued')
    records.delete('spawned-1')
    expect(await pass()).toHaveLength(1)
    expect(spawned.map(request => request.projectPath)).toEqual([featX, featY])
  })

  test('the default team cap is 5', async () => {
    writeGroup('devs', 'max: 10')
    const worktrees = Array.from({ length: 6 }, (_, index) => {
      const target = path.join(root, `cap-${index}`)
      if (!fs.existsSync(target)) git(['worktree', 'add', '-q', '-b', `cap-${index}`, target], repo)
      return target
    })
    for (const target of worktrees) mail(task(target).id)
    expect(await pass()).toHaveLength(5)
    for (const target of worktrees) git(['worktree', 'remove', '--force', target], repo)
  })

  test('competing passes reserve inside one transaction and never exceed a cap', async () => {
    const t = task(featX)
    mail(t.id)
    mail(t.id)
    const other = makeStaffing()
    const results = await Promise.all([pass(), pass(other), pass()])
    expect(results.flat()).toHaveLength(1)
    expect(spawned).toHaveLength(1)
  })

  test('a pending reservation counts toward the caps', async () => {
    db.db.prepare("INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at) VALUES ('r', 'm', ?, 'qa', ?, 'now')").run(team.teamId, featX)
    mail(task(featX).id)
    expect(await pass()).toEqual([])
  })
})

describe('per-profile caps (profile routing)', () => {
  test('a reached profile cap moves spawns to the next allowed profile', async () => {
    writeGroup('devs', 'profiles: { glm: 1, minimax: 1 }')
    records.set('dev-glm', record('dev-glm', { projectPath: repo, claudeProfileId: 'glm' }))
    mail(task(featX).id)
    expect(await pass()).toHaveLength(1)
    expect(spawned.map(request => request.profileId)).toEqual(['minimax'])
  })

  test('user-created members count; with every profile at its cap nothing is spawned', async () => {
    writeGroup('devs', 'profiles: { glm: 1, minimax: 1 }')
    records.set('dev-glm', record('dev-glm', { projectPath: repo, claudeProfileId: 'glm' }))
    records.set('dev-mm', record('dev-mm', { projectPath: featY, claudeProfileId: 'minimax' }))
    const m = mail(task(featX).id)
    expect(await pass()).toEqual([])
    expect(store.get(m.id)?.state).toBe('queued')
  })

  test('members of other groups never count toward a cap', async () => {
    writeGroup('devs', 'profiles: { glm: 1 }')
    records.set('qa-glm', record('qa-glm', { projectPath: repo, groupId: 'qa', claudeProfileId: 'glm' }))
    mail(task(featX).id)
    expect(await pass()).toHaveLength(1)
  })

  test('concurrent spawns on one profile re-count inside the reservation and never overshoot', async () => {
    writeGroup('devs', 'profiles: { glm: 1 }\nmax: 5')
    const group = (await loadTeamGroups(repo, home)).catalog.groups.get('devs')!.group
    const first = mail(task(featX).id)
    const second = mail(task(featY).id)
    const other = makeStaffing()
    const results = await Promise.all([
      staffing.spawnFor(first, featX, group, 'glm'), other.spawnFor(second, featY, group, 'glm'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(spawned).toHaveLength(1)
    expect(results.some(result => result === null)).toBe(true)
  })

  test('a pending reservation on a profile holds its slot', async () => {
    writeGroup('devs', 'profiles: { glm: 1, minimax: 1 }')
    db.db.prepare("INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at, profile_id) VALUES ('r', 'm', ?, 'devs', ?, 'now', 'glm')")
      .run(team.teamId, featY)
    mail(task(featX).id)
    expect(await pass()).toHaveLength(1)
    expect(spawned.map(request => request.profileId)).toEqual(['minimax'])
  })
})

describe('failure, restart, and removal', () => {
  test('a failed spawn drops its reservation, requeues the mail, and backs off', async () => {
    spawnFails = 'profile glm is not defined'
    const errors: unknown[] = []
    staffing = makeStaffing(error => errors.push(error))
    const m = mail(task(featX).id)
    expect(await pass()).toEqual([])
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null })
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    expect(String(errors[0])).toContain('profile glm is not defined')
    await pass()
    expect(spawned).toHaveLength(1)
    clock += 31_000
    spawnFails = null
    expect(await pass()).toHaveLength(1)
  })

  test('a failed reserve throws inside the transaction, rolls the reservation insert back, and keeps the end state', async () => {
    const group = (await loadTeamGroups(repo, home)).catalog.groups.get('devs')!.group
    const m = mail(task(featX).id)
    // The message left the queue before the reserve ran (e.g. cancelled
    // during the awaited group resolution).
    store.cancel(m.id, { kind: 'human' })
    let thrown: unknown = null
    try {
      await staffing.spawnFor(m, featX, group, 'glm')
    } catch (error) { thrown = error }
    expect(String(thrown)).toContain('Reserving')
    // The insert rolled back with the transaction: no leaked reservation.
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    expect(store.get(m.id)?.state).toBe('cancelled')
  })

  test('a failed reserve reaches the dispatcher error path, not a quiet return', async () => {
    const group = (await loadTeamGroups(repo, home)).catalog.groups.get('devs')!.group
    const m = mail(task(featX).id)
    const errors: unknown[] = []
    const dispatcher = new MailDispatcher(store, {
      recipients: () => [], prepare: async () => {}, interrupt: async () => {}, deliver: () => {}, watchReceipt: () => {},
      // The router plays the role ProfileRouter does: spawnFor inside
      // route(). The human cancels while that decision is awaited — the
      // message is queued when the pass enumerates it, gone when the
      // reserve runs.
      router: { route: async () => {
        store.cancel(m.id, { kind: 'human' })
        const assignment = await staffing.spawnFor(store.get(m.id)!, featX, group, 'glm')
        return assignment ? { kind: 'spawned', assignment } : { kind: 'none' }
      } },
      onError: error => errors.push(error),
    })
    try {
      dispatcher.notify(); await dispatcher.settled()
    } finally { dispatcher.close() }
    // The throw reached the dispatcher's error path (groupPass catch → onError).
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('Reserving')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    expect(store.get(m.id)?.state).toBe('cancelled')
  })

  test('a spawn backoff exposes its retry time and is recorded before the requeue', async () => {
    spawnFails = 'nope'
    const backoffAt: Array<{ rowState: string; retryAt: number }> = []
    staffing = makeStaffing(undefined, {
      retryAfterMs: 25_000,
      onSpawnBackoff: (message, retryAt) => backoffAt.push({ rowState: message.state, retryAt }),
    })
    const m = mail(task(featX).id)
    expect(await pass()).toEqual([])
    // Recorded while the row was still `spawning`: before the requeue notify.
    expect(backoffAt).toEqual([{ rowState: 'spawning', retryAt: clock + 25_000 }])
    expect(staffing.nextRetryAt()).toBe(clock + 25_000)
    // A cleared (dead) backoff never arms the timer again.
    staffing.clearBackoff(m.id)
    expect(staffing.nextRetryAt()).toBeNull()
  })

  test('an expired backoff is not reported by nextRetryAt', async () => {
    spawnFails = 'nope'
    staffing = makeStaffing(undefined, { retryAfterMs: 10_000 })
    mail(task(featX).id)
    expect(await pass()).toEqual([])
    clock += 11_000
    expect(staffing.nextRetryAt()).toBeNull()
  })

  test('startup reconciliation drops interrupted reservations and requeues reserved mail', () => {
    const m = mail(task(featX).id)
    store.reserveForSpawn(m.id)
    db.db.prepare("INSERT INTO team_spawns (id, message_id, team_id, group_id, worktree, created_at) VALUES ('r', ?, ?, 'devs', ?, 'now')").run(m.id, team.teamId, featX)
    const pushed = mail(null)
    store.claim(pushed.id, 'dev'); store.markPushed(pushed.id)
    staffing.reconcile()
    expect(store.get(m.id)?.state).toBe('queued')
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM team_spawns').get()).toEqual({ n: 0 })
    // Pushed claims are left to receipt recovery, never requeued here.
    expect(store.get(pushed.id)).toMatchObject({ state: 'claimed', pushedAt: expect.any(String) })
  })

  test('mail for a removed worktree is dead-lettered and no worktree is created', async () => {
    const doomed = path.join(root, 'doomed')
    git(['worktree', 'add', '-q', '-b', 'doomed', doomed], repo)
    const t = task(doomed)
    const m = mail(t.id)
    fs.rmSync(doomed, { recursive: true, force: true })
    const before = git(['worktree', 'list', '--porcelain'], repo)
    expect(await pass()).toEqual([])
    expect(store.get(m.id)).toMatchObject({ state: 'dead', reason: `worktree-missing: ${doomed}` })
    expect(spawned).toEqual([])
    expect(git(['worktree', 'list', '--porcelain'], repo)).toBe(before)
    expect(fs.existsSync(doomed)).toBe(false)
    git(['worktree', 'prune'], repo)
  })
})

describe('dispatcher routing by worktree', () => {
  let recipients: MailRecipient[]
  let delivered: Array<{ to: string; id: string }>
  let dispatcher: MailDispatcher
  const member = (sessionId: string, projectPath: string, idle = true): MailRecipient => ({
    sessionId, teamId: team.teamId, groupId: 'devs', idle, pendingRequest: false, available: true, worktree: worktreeRootOf(projectPath),
  })
  const run = async () => { dispatcher.notify(); await dispatcher.settled() }
  beforeEach(() => {
    recipients = []
    delivered = []
    dispatcher = new MailDispatcher(store, {
      recipients: () => recipients, prepare: async () => {}, interrupt: async () => {},
      deliver: (id, peer) => { delivered.push({ to: id, id: peer.messageId }); recipients.find(row => row.sessionId === id)!.idle = false },
      watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
    })
  })
  afterEach(() => dispatcher.close())

  test('only a member in the target worktree takes it — including from a subdirectory', async () => {
    recipients.push(member('main', repo), member('in-y', featY), member('in-x-src', path.join(featX, 'src')))
    const m = mail(task(featX).id)
    await run()
    expect(delivered).toEqual([{ to: 'in-x-src', id: m.id }])
  })

  test('a member elsewhere skips worktree mail but keeps ordinary mail in order', async () => {
    recipients.push(member('main', repo))
    const targeted = mail(task(featX).id, { priority: 'urgent' })
    const plain = mail(null)
    await run()
    expect(delivered).toEqual([{ to: 'main', id: plain.id }])
    expect(store.get(targeted.id)?.state).toBe('queued')
  })

  test('a cwd move into the worktree makes the member eligible; moving out does not keep it', async () => {
    const dev = member('dev', repo)
    recipients.push(dev)
    const m = mail(task(featX).id)
    await run()
    expect(delivered).toEqual([])
    dev.worktree = worktreeRootOf(path.join(featX, 'src'))
    await run()
    expect(delivered).toEqual([{ to: 'dev', id: m.id }])
  })

  test('the staffing hook delivers reserved mail as the spawned member’s first turn, once', async () => {
    const m = mail(task(featX).id)
    const staff = makeStaffing()
    dispatcher.close()
    dispatcher = new MailDispatcher(store, {
      recipients: () => [...records.values()].filter(row => row.spawned).map(row => member(row.sessionId, row.projectPath)),
      prepare: async () => {}, interrupt: async () => {},
      deliver: (id, peer) => delivered.push({ to: id, id: peer.messageId }),
      watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
      router: makeRouter(staff),
    })
    await run()
    await run()
    expect(delivered).toEqual([{ to: 'spawned-1', id: m.id }])
    expect(store.get(m.id)).toMatchObject({ state: 'claimed', claimedBy: 'spawned-1' })
  })

  test('reserved mail the spawned member could not take goes back to the queue', async () => {
    const m = mail(task(featX).id)
    const staff = makeStaffing()
    dispatcher.close()
    dispatcher = new MailDispatcher(store, {
      recipients: () => [], prepare: async () => {}, interrupt: async () => {},
      deliver: () => { throw new Error('unreachable') }, watchReceipt: () => {},
      targetWorktree: message => (message.taskId ? tasks.get(message.taskId)?.worktree ?? null : null),
      router: makeRouter(staff),
    })
    await run()
    expect(store.get(m.id)).toMatchObject({ state: 'queued', claimedBy: null })
  })
})
