// The registered `task_list` tool (bounded-task-list D1–D4): oracle rows
// S1–S4 (status filter), W1–W6 (window), R1–R2 (row projection), and the
// P1–P2 properties, all through both runtimes' real adapters — the Claude
// team MCP server's registered tool and the Codex dynamic-tool dispatch,
// both built from teamToolTable — with their refusal envelopes. Ground truth
// is the seeded rows and their insertion order.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import type { AgentTaskRow, TaskStatus } from '../../shared/teamTasks'
import { TASK_STATUSES } from '../../shared/teamTasks'
import { schemaCopy } from './schemaDb'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { createMailboxServer, teamToolTable, type MailboxServerServices } from '../team/mailboxTools'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { dispatchTeamToolCall } from '../chat/codex/codexTools'
import { at, mulberry32 } from './taskJournalFixture'

const THREAD = 'thread-task-list'
type Outcome = { error: string; value: null } | { error: null; value: any }
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>

let root: string
let repo: string
let team: TeamIdentity
let otherTeam: TeamIdentity
let db: Database
let mail: MailboxStore
let assignments: AssignmentStore
let records: Map<string, ChatSessionRecord>
let tasks: TaskService
let mailbox: TeamMailbox
const servers: Array<{ instance: { close: () => Promise<void> } }> = []

const row = (sessionId: string, groupId: string, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const git = (args: string[], cwd: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}
const services = (): MailboxServerServices => ({ tasks })

/** The Claude runtime: the session's real team MCP server and its registered tool, which answers isError text on a refusal. */
async function viaClaude(sessionId: string, name: string, args: unknown): Promise<Outcome> {
  const server = await createMailboxServer(mailbox, sessionId, services())
  servers.push(server as unknown as { instance: { close: () => Promise<void> } })
  const tool = (server.instance as unknown as { _registeredTools: Registered })._registeredTools[name]!
  const result = await tool.handler(args, {})
  const text = result.content[0]!.text
  return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) }
}

/** The Codex runtime: the dynamic-tool dispatch over the same table, which answers success false with text on a refusal. */
async function viaCodex(sessionId: string, name: string, args: unknown): Promise<Outcome> {
  const answer = await dispatchTeamToolCall(teamToolTable(mailbox, sessionId, services()), THREAD,
    { threadId: THREAD, namespace: 'kawai-team', tool: name, arguments: args } as never)
  const item = answer.contentItems[0]!
  const text = item.type === 'inputText' ? item.text : ''
  return answer.success ? { error: null, value: JSON.parse(text) } : { error: text, value: null }
}

const RUNTIMES = [{ runtime: 'Claude', call: viaClaude }, { runtime: 'Codex', call: viaCodex }] as const

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-list-')))
  repo = path.join(root, 'repo')
  const other = path.join(root, 'other')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir], root)
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  clearTeamCache()
  team = await resolveTeam(repo)
  otherTeam = await resolveTeam(other)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')]])
  db?.close()
  db = schemaCopy()
  mail = new MailboxStore(db)
  assignments = new AssignmentStore(db, mail)
  tasks = new TaskService(new TaskStore(db, mail, assignments), { getSession: id => records.get(id) })
  mailbox = new TeamMailbox(mail, { getSession: id => records.get(id), homeDir: root })
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.instance.close()))
})

const LEAD = { kind: 'agent' as const, sessionId: 'lead' }

/** A task of `teamId` created at `at(seconds)` with `status`; direction and acceptance as given. */
function seed(status: TaskStatus, seconds: number, extra: { teamId?: string; direction?: string; title?: string } = {}): string {
  const task = tasks.store.create({
    teamId: extra.teamId ?? team.teamId, title: extra.title ?? `${status} ${seconds}`, direction: extra.direction ?? 'd', creator: LEAD,
  }, at(seconds))
  if (status !== 'open') db.prepare('UPDATE team_tasks SET status = ? WHERE id = ?').run(status, task.id)
  return task.id
}

/** The team mix of the spec's scenarios: 10 open, 4 active, 11 blocked, 405 done, 12 cancelled. */
function seedMix(): Record<TaskStatus, string[]> {
  const counts: Record<TaskStatus, number> = { open: 10, active: 4, blocked: 11, done: 405, cancelled: 12 }
  const ids: Record<TaskStatus, string[]> = { open: [], active: [], blocked: [], done: [], cancelled: [] }
  let seconds = 0
  db.transaction(() => {
    for (const status of TASK_STATUSES) for (let i = 0; i < counts[status]; i++) ids[status].push(seed(status, seconds++))
  })()
  return ids
}

/** Every page from the first window to the end. */
async function pageAll(call: (typeof RUNTIMES)[number]['call'], args: Record<string, unknown>) {
  const pages: any[] = []
  let before: string | undefined
  for (;;) {
    const { error, value } = await call('dev', 'task_list', { ...args, ...(before ? { before } : {}) })
    expect(error).toBeNull()
    pages.push(value)
    if (!value.bounds.truncated) return pages
    before = value.bounds.nextBefore
  }
}

const ROW_KEYS: Array<keyof AgentTaskRow> = ['id', 'title', 'status', 'creator', 'parentId', 'worktree', 'openspecChange', 'planId',
  'planChange', 'revision', 'createdAt', 'updatedAt', 'assignee', 'result']

for (const { runtime, call } of RUNTIMES) {
  describe(`task_list status filter through the ${runtime} adapter (S1–S4)`, () => {
    // @covers: team-tasks › task_list excludes closed tasks by default › Default omits finished work
    // @covers: team-tasks › task_list excludes closed tasks by default › Asking for done tasks
    // @covers: team-tasks › task_list excludes closed tasks by default › Asking for everything
    test('S1–S3: the default is the open set, a status selects itself, and all lifts the filter (kills "no default filter")', async () => {
      const ids = seedMix()
      const table: Array<{ oracle: string; status?: string; statuses: TaskStatus[]; total: number }> = [
        { oracle: 'S1', statuses: ['open', 'active', 'blocked'], total: 25 },
        { oracle: 'S2', status: 'all', statuses: [...TASK_STATUSES], total: 442 },
        ...TASK_STATUSES.map(status => ({ oracle: 'S3', status, statuses: [status], total: ids[status].length })),
      ]
      for (const row of table) {
        const pages = await pageAll(call, { ...(row.status ? { status: row.status } : {}), limit: 200 })
        const listed = pages.flatMap(page => page.tasks as AgentTaskRow[])
        expect({ oracle: row.oracle, statuses: pages[0].statuses, total: pages[0].bounds.total })
          .toEqual({ oracle: row.oracle, statuses: row.statuses, total: row.total })
        expect(new Set(listed.map(task => task.id))).toEqual(new Set(row.statuses.flatMap(status => ids[status])))
      }
    })

    // @covers: team-tasks › task_list excludes closed tasks by default › Unknown status
    test('S4: an unknown status is refused naming the accepted values in the runtime\'s envelope (kills "any string")', async () => {
      seed('open', 0)
      for (const status of ['closed', '', 'ALL', 3]) {
        const { error, value } = await call('dev', 'task_list', { status })
        expect(value).toBeNull()
        expect(error).toContain('status must be one of open, active, blocked, done, cancelled, all')
      }
    })
  })

  describe(`task_list window through the ${runtime} adapter (W1–W6)`, () => {
    // @covers: team-tasks › task_list is bounded and paged › Small team is whole
    test('W1: a small team is whole, newest first, not truncated', async () => {
      const written = [seed('open', 0), seed('open', 1), seed('open', 2)]
      const { error, value } = await call('dev', 'task_list', {})
      expect(error).toBeNull()
      expect(value.tasks.map((task: AgentTaskRow) => task.id)).toEqual([...written].reverse())
      expect(value.bounds).toEqual({ total: 3, returned: 3, truncated: false, nextBefore: null })
    })

    // @covers: team-tasks › task_list is bounded and paged › Large backlog
    test('W2: a large backlog returns the newest 50 with a next anchor (kills "LIMIT n")', async () => {
      const done = seedMix().done
      const { value } = await call('dev', 'task_list', { status: 'done' })
      expect(value.tasks.map((task: AgentTaskRow) => task.id)).toEqual(done.slice(-50).reverse())
      expect(value.bounds).toEqual({ total: 405, returned: 50, truncated: true, nextBefore: done[355] })
    })

    // @covers: team-tasks › task_list is bounded and paged › Paging to the end
    // @covers: team-tasks › task_list is bounded and paged › Anchor that does not match the filter
    test('W3, W4: anchors page strictly older, ties included, any status; the oldest anchor ends it (kills the dropped rowid tie-break)', async () => {
      // Six tasks share one creation time; insertion order (rowid) breaks the tie.
      const tied = db.transaction(() => Array.from({ length: 6 }, (_, i) => seed(i % 2 ? 'done' : 'open', 7)))()
      const later = seed('active', 9)
      const open = tied.filter((_, i) => i % 2 === 0)
      const page = (await call('dev', 'task_list', { before: tied[3] })).value
      expect(page.tasks.map((task: AgentTaskRow) => task.id)).toEqual([tied[2], tied[0]])
      expect(page.bounds).toEqual({ total: 4, returned: 2, truncated: false, nextBefore: null })
      const pages = await pageAll(call, { limit: 1 })
      expect(pages.flatMap(entry => entry.tasks.map((task: AgentTaskRow) => task.id))).toEqual([later, ...[...open].reverse()])
      expect(pages.every(entry => entry.bounds.total === 4)).toBe(true)
      const oldest = (await call('dev', 'task_list', { status: 'all', before: tied[0] })).value
      expect(oldest.tasks).toEqual([])
      expect(oldest.bounds).toEqual({ total: 7, returned: 0, truncated: false, nextBefore: null })
    })

    // @covers: team-tasks › task_list is bounded and paged › Unknown or foreign anchor
    // @covers: team-tasks › task_list is bounded and paged › Limit out of range
    test('W5, W6: a foreign or unknown anchor and an out-of-range limit are refused in the runtime\'s envelope (kills the anchor without team_id)', async () => {
      seed('open', 0)
      const foreign = seed('open', 1, { teamId: otherTeam.teamId })
      for (const anchor of [foreign, 'task-unknown']) {
        const { error, value } = await call('dev', 'task_list', { before: anchor })
        expect(value).toBeNull()
        expect(error).toContain(`Unknown task for this team: ${anchor}`)
      }
      for (const limit of [0, 201, 1.5, '5']) {
        const { error, value } = await call('dev', 'task_list', { limit })
        expect(value).toBeNull()
        expect(error).toContain('limit must be an integer from 1 to 200')
      }
    })
  })

  describe(`task_list rows through the ${runtime} adapter (R1–R2)`, () => {
    // @covers: team-tasks › task_list returns compact rows › Row omits the task's text
    test('R1: rows carry every compact key and none of the task\'s text (kills spreading the full task)', async () => {
      const direction = `DIRECTION-MARK-${'d'.repeat(10_000)}`
      const acceptance = `ACCEPTANCE-MARK-${'a'.repeat(4_000)}`
      const instruction = `INSTRUCTION-MARK-${'i'.repeat(4_000)}`
      const id = seed('open', 0, { direction })
      await tasks.amend({ kind: 'agent', sessionId: 'lead' }, id, { acceptance })
      dispatch(id, 'devs', instruction, 'delivered', 1)
      const { value } = await call('dev', 'task_list', { status: 'all' })
      const serialized = JSON.stringify(value)
      for (const mark of ['DIRECTION-MARK', 'ACCEPTANCE-MARK', 'INSTRUCTION-MARK']) expect(serialized).not.toContain(mark)
      expect(Object.keys(value.tasks[0]).sort()).toEqual([...ROW_KEYS].sort())
      expect(value.tasks[0].revision).toBe(2)
    })
  })
}

/** An assignment of `taskId` to `group` whose instruction mail is in `state`, claimed by `claimant` when given. */
function dispatch(taskId: string, group: string, instruction: string, state: string, seconds: number, claimant: string | null = null) {
  const message = mail.enqueue({
    teamId: team.teamId, toKind: 'group', toId: group, fromSession: 'lead', fromGroup: null, originPath: repo, body: instruction, taskId,
  }, at(seconds))
  const { assignment } = assignments.insert({
    teamId: team.teamId, taskId, requestKey: `key-${crypto.randomUUID()}`, targetKind: 'group', targetId: group, role: group,
    instruction, creator: LEAD, messageId: message.id,
  }, at(seconds))
  db.prepare('UPDATE team_messages SET state = ?, claimed_by = ? WHERE id = ?').run(state, claimant, message.id)
  db.prepare('UPDATE team_task_assignments SET claimed_by = ? WHERE id = ?').run(claimant, assignment.id)
  return assignment
}

/** A result of `taskId` with findings of each given verdict, in order, accepted when asked. */
function result(taskId: string, verdicts: Array<'pass' | 'fail'>, accepted = false) {
  const inserted = tasks.store.results.insert({
    teamId: team.teamId, taskId, summary: 's', commit: 'abc', diff: null, worktree: null, tests: [], limitations: null,
    taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' },
  })
  for (const verdict of verdicts) {
    tasks.store.results.insertFindings({
      teamId: team.teamId, taskId, resultId: inserted.id, handoffId: null, kind: 'review', verdict, findings: verdict,
      author: { kind: 'agent', sessionId: 'reviewer' },
    })
  }
  if (accepted) tasks.store.results.markAccepted(inserted.id, { kind: 'human', sessionId: null })
  return inserted
}

describe('task_list rows equal the summary derivation (R2)', () => {
  // @covers: team-tasks › task_list returns compact rows › Assignee and result are compact
  // @covers: team-tasks › task_list returns compact rows › Unassigned task without a result
  test('R2: assignee and result project TeamTaskSummary for every assignment and result shape (kills newest-row state)', async () => {
    const cases: Array<{ name: string; arrange: (id: string) => void }> = [
      { name: 'queued', arrange: id => dispatch(id, 'devs', 'q', 'queued', 1) },
      { name: 'claimed by a middle dev, passing review', arrange: id => { dispatch(id, 'middle-devs', 'c', 'claimed', 1, 'dev'); result(id, ['pass']) } },
      { name: 'delivered, then a failed newer dispatch', arrange: id => { dispatch(id, 'devs', 'd', 'delivered', 1, 'dev'); dispatch(id, 'devs', 'f', 'dead', 2) } },
      { name: 'superseded, then replaced', arrange: id => {
        const old = dispatch(id, 'devs', 'old', 'delivered', 1, 'dev')
        const fresh = dispatch(id, 'reviewers', 'new', 'queued', 2)
        assignments.supersede(old.id, fresh.id)
      } },
      { name: 'only failed', arrange: id => dispatch(id, 'devs', 'x', 'dead', 1) },
      { name: 'unassigned without a result', arrange: () => {} },
      { name: 'failing review after a pass', arrange: id => result(id, ['pass', 'fail']) },
      { name: 'result without findings, accepted', arrange: id => result(id, [], true) },
    ]
    const ids = cases.map((entry, i) => { const id = seed('open', 100 + i, { title: entry.name }); entry.arrange(id); return id })
    const listed = (await viaClaude('dev', 'task_list', { limit: 200 })).value.tasks as AgentTaskRow[]
    for (const id of ids) {
      const summary = tasks.store.summary(tasks.store.get(id)!)
      const listedRow = listed.find(task => task.id === id)!
      const expected = {
        assignee: summary.assignment ? {
          targetKind: summary.assignment.targetKind, targetId: summary.assignment.targetId, role: summary.assignment.role,
          claimedBy: summary.assignment.claimedBy, state: summary.assignment.state,
        } : null,
        result: summary.outstandingResult ?? null,
      }
      expect({ title: listedRow.title, assignee: listedRow.assignee, result: listedRow.result }).toEqual({ title: summary.title, ...expected })
    }
    const byTitle = Object.fromEntries(listed.map(task => [task.title, task]))
    expect(byTitle['claimed by a middle dev, passing review']).toMatchObject({
      assignee: { targetId: 'middle-devs', claimedBy: 'dev', state: 'claimed' }, result: { reviewVerdict: 'pass' },
    })
    expect(byTitle['delivered, then a failed newer dispatch']!.assignee).toMatchObject({ state: 'delivered' })
    expect(byTitle['unassigned without a result']).toMatchObject({ assignee: null, result: null })
  })
})

describe('task_list properties (P1–P2)', () => {
  test('P1, P2: paging any filter at any limit yields the filtered set once, newest first, each page within its limit (seed 0x7a5c, 200 cases)', async () => {
    const random = mulberry32(0x7a5c)
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const filters: Array<string | undefined> = [undefined, 'all', ...TASK_STATUSES]
    // The production handler composition, not the store (oracle hazard M1).
    const handlers = taskHandlers(tasks, 'dev')
    for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
      db.exec('DELETE FROM team_tasks')
      const count = Math.floor(random() * 121)
      const seeded = db.transaction(() => Array.from({ length: count }, () => {
        const status = pick(TASK_STATUSES)
        return { id: seed(status, Math.floor(random() * 5)), status }
      }))()
      const filter = pick(filters)
      const limit = 1 + Math.floor(random() * 30)
      const statuses: TaskStatus[] = filter === undefined ? ['open', 'active', 'blocked'] : filter === 'all' ? [...TASK_STATUSES] : [filter as TaskStatus]
      const order = db.prepare(`SELECT id FROM team_tasks WHERE status IN (${statuses.map(() => '?').join(', ')})
        ORDER BY created_at DESC, rowid DESC`).all(...statuses) as Array<{ id: string }>
      const expected = order.map(entry => entry.id)
      expect(expected.length).toBe(seeded.filter(entry => statuses.includes(entry.status)).length)
      const listed: string[] = []
      let before: string | undefined
      for (;;) {
        const page = await handlers.task_list({ ...(filter ? { status: filter } : {}), limit, ...(before ? { before } : {}) })
        const remaining = expected.length - listed.length
        expect(page.bounds.total).toBe(expected.length)
        expect(page.bounds.returned).toBe(Math.min(limit, remaining))
        expect(page.tasks.length).toBeLessThanOrEqual(limit)
        listed.push(...page.tasks.map(task => task.id))
        if (!page.bounds.truncated) break
        before = page.bounds.nextBefore!
      }
      expect(listed).toEqual(expected)
    }
  })
})
