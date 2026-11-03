// Task service and tools (team-tasks D2): creation rights read from the
// caller's current group file, same-team references, worktree and OpenSpec
// validation, the amend/status permission matrix, and identity binding.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let feature: string
let other: string
let home: string
let db: Database
let records: Map<string, ChatSessionRecord>
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

const writeGroup = (id: string, content: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), content)
}
const row = (sessionId: string, groupId: string | null, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-service-')))
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
  writeGroup('leads', '---\ncanCreateTasks: true\n---\nLead.')
  writeGroup('change-leads', '---\ncanCreateTasks: true\n---\nCoordinate.')
  writeGroup('devs', 'Build.')
  records = new Map([
    ['lead', row('lead', 'leads')],
    ['lead2', row('lead2', 'leads')],
    ['cl', row('cl', 'change-leads')],
    ['cl2', row('cl2', 'change-leads')],
    ['dev', row('dev', 'devs', path.join(feature))],
    ['solo', row('solo', null)],
    ['stranger', row('stranger', 'leads', other)],
  ])
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: home })
})

describe('creation rights', () => {
  test('a permitted group member creates a task and becomes its creator', async () => {
    const task = await service.create(agent('lead'), { title: 'Export', direction: 'CSV' })
    expect(task).toMatchObject({ teamId: team.teamId, status: 'open', revision: 1, creator: { kind: 'agent', sessionId: 'lead' } })
  })

  test('the default (no canCreateTasks) and group-less sessions are refused; nothing is written', async () => {
    await expect(service.create(agent('dev'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    await expect(service.create(agent('solo'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    expect((await service.agentList(human(), { status: 'all' })).tasks).toEqual([])
  })

  test('the setting is read fresh from the group file on every call', async () => {
    writeGroup('devs', '---\ncanCreateTasks: true\n---\nBuild.')
    expect((await service.create(agent('dev'), { title: 'x', direction: 'y' })).creator).toEqual({ kind: 'agent', sessionId: 'dev' })
    writeGroup('leads', 'Lead.')
    await expect(service.create(agent('lead'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
  })

  test('the human always creates; an unknown caller session is refused', async () => {
    expect((await service.create(human(), { title: 'x', direction: 'y' })).creator).toEqual({ kind: 'human', sessionId: null })
    await expect(service.create(agent('ghost'), { title: 'x', direction: 'y' })).rejects.toThrow('Unknown calling session')
  })

  test('blank title or direction is refused', async () => {
    await expect(service.create(human(), { title: ' ', direction: 'y' })).rejects.toThrow('title')
    await expect(service.create(human(), { title: 'x', direction: '' })).rejects.toThrow('direction')
  })
})

describe('references', () => {
  test('parent of the same team; another team’s parent or task is not found', async () => {
    const parent = await service.create(human(), { title: 'parent', direction: 'p' })
    const child = await service.create(agent('lead'), { title: 'child', direction: 'c', parent_id: parent.id })
    expect(child.parentId).toBe(parent.id)
    const foreign = await service.create({ kind: 'human', team: await resolveTeam(other) }, { title: 'foreign', direction: 'f' })
    await expect(service.create(agent('lead'), { title: 'x', direction: 'y', parent_id: foreign.id })).rejects.toThrow('Parent task not found')
    await expect(service.get(agent('lead'), foreign.id)).rejects.toThrow('not found in this team')
    await expect(service.note(agent('dev'), foreign.id, 'hi')).rejects.toThrow('not found in this team')
    // Newest first (bounded-task-list D3); the foreign team's task is not listed.
    expect((await service.agentList(agent('lead'))).tasks.map(task => task.title)).toEqual(['child', 'parent'])
  })

  test('worktree targets normalize to their root; other paths are refused by name', async () => {
    const task = await service.create(human(), { title: 'x', direction: 'y', worktree: `${feature}/` })
    expect(task.worktree).toBe(feature)
    const sub = path.join(repo, 'src')
    fs.mkdirSync(sub, { recursive: true })
    await expect(service.create(human(), { title: 'x', direction: 'y', worktree: sub })).rejects.toThrow(sub)
    await expect(service.create(human(), { title: 'x', direction: 'y', worktree: other })).rejects.toThrow(other)
  })

  test('linked OpenSpec changes must exist in the main checkout or the task worktree', async () => {
    expect((await service.create(human(), { title: 'x', direction: 'y', openspec_change: 'add-export' })).openspecChange).toBe('add-export')
    expect((await service.create(human(), { title: 'x', direction: 'y', worktree: feature, openspec_change: 'branch-only' })).openspecChange).toBe('branch-only')
    for (const name of ['branch-only', 'missing', 'archive', '../escape']) {
      await expect(service.create(human(), { title: 'x', direction: 'y', openspec_change: name })).rejects.toThrow('OpenSpec change not found')
    }
  })
})

describe('permission matrix', () => {
  test('amend: creator and human only; contributors are pointed to a note or message', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'v1' })
    await expect(service.amend(agent('dev'), task.id, { direction: 'hijack' })).rejects.toThrow(/task_note.*message the creator \(lead\)/)
    await expect(service.amend(agent('lead2'), task.id, { direction: 'hijack' })).rejects.toThrow('creator')
    // A refused amendment writes nothing (task-revision-publication 2.2).
    expect(service.store.revisions(task.id)).toHaveLength(1)
    expect(service.store.get(task.id)?.revision).toBe(1)
    expect((await service.amend(agent('lead'), task.id, { direction: 'v2' })).revision).toBe(2)
    expect((await service.amend(human(), task.id, { acceptance: 'ships' })).revision).toBe(3)
    expect((await service.get(human(), task.id)).revisions.map(revision => revision.direction)).toEqual(['v1', 'v2', 'v2'])
    await expect(service.amend(agent('lead'), task.id, {})).rejects.toThrow('Nothing to amend')
  })

  test('a human-created task can be amended by no agent', async () => {
    const task = await service.create(human(), { title: 'x', direction: 'v1' })
    await expect(service.amend(agent('lead'), task.id, { direction: 'v2' })).rejects.toThrow('message the creator (the human)')
  })

  test('notes and active/blocked are open to every member; done/cancelled to the creator', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'y' })
    expect((await service.note(agent('dev'), task.id, 'Picked option B')).author).toEqual({ kind: 'agent', sessionId: 'dev' })
    expect((await service.setStatus(agent('dev'), task.id, 'active')).status).toBe('active')
    expect((await service.setStatus(agent('dev'), task.id, 'blocked', 'waiting on API')).status).toBe('blocked')
    await expect(service.setStatus(agent('dev'), task.id, 'done')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('dev'), task.id, 'cancelled')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('lead'), task.id, 'open')).rejects.toThrow('Only the human can reopen')
    expect((await service.get(human(), task.id)).task.status).toBe('blocked')
    expect((await service.setStatus(agent('lead'), task.id, 'done')).status).toBe('done')
    expect((await service.get(human(), task.id)).journal.map(entry => entry.text)).toEqual(['Picked option B', 'waiting on API'])
  })

  test('the human reopens, closes, and amends a task whose creator was killed', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'y' })
    await service.setStatus(agent('lead'), task.id, 'done')
    records.delete('lead')
    expect((await service.setStatus(human(), task.id, 'open')).status).toBe('open')
    expect((await service.amend(human(), task.id, { direction: 'new plan' })).direction).toBe('new plan')
    expect((await service.setStatus(human(), task.id, 'cancelled')).status).toBe('cancelled')
    expect((await service.note(human(), task.id, 'closing')).author).toEqual({ kind: 'human', sessionId: null })
    await expect(service.note(agent('lead'), task.id, 'ghost')).rejects.toThrow('Unknown calling session')
  })
})

describe('change-lead pilot composition (change-lead-pilot D3/D6)', () => {
  test('parent/child creator asymmetry under the pilot: the parent creator cannot amend or close the Change Lead\'s child; the human can; the child records parent, change, and creator', async () => {
    const parent = await service.create(agent('lead'), { title: 'pilot parent', direction: 'enrolled', openspec_change: 'add-export' })
    const child = await service.create(agent('cl'), {
      title: 'serializer', direction: 'Pilot parent: <parent>\nChange: add-export\nCoordinator: cl',
      parent_id: parent.id, openspec_change: 'add-export', worktree: feature,
    })
    // The child is the Change Lead's: its own creator rights, the parent link, the change, the worktree.
    expect(child).toMatchObject({ parentId: parent.id, openspecChange: 'add-export', worktree: feature, creator: { kind: 'agent', sessionId: 'cl' } })
    // Parent ownership grants no child authority: amend and closure are refused, writing nothing.
    await expect(service.amend(agent('lead'), child.id, { direction: 'hijack' })).rejects.toThrow('creator')
    await expect(service.setStatus(agent('lead'), child.id, 'done')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('lead'), child.id, 'cancelled')).rejects.toThrow('Only the task\'s creator')
    expect(service.store.revisions(child.id)).toHaveLength(1)
    // The child's creator amends and closes, recording that closure is not acceptance.
    expect((await service.amend(agent('cl'), child.id, { direction: 'v2' })).revision).toBe(2)
    await service.note(agent('cl'), child.id, 'closing: acceptance holds; closure is not result acceptance')
    expect((await service.setStatus(agent('cl'), child.id, 'done')).status).toBe('done')
    // The human amends and closes regardless of who created the task.
    expect((await service.setStatus(human(), child.id, 'open')).status).toBe('open')
    expect((await service.amend(human(), child.id, { acceptance: 'assembled checks hold' })).acceptance).toBe('assembled checks hold')
    expect((await service.setStatus(human(), child.id, 'done')).status).toBe('done')
  })

  test('a replacement Change Lead cannot amend or close the original coordinator\'s children, but can coordinate within existing rights', async () => {
    const parent = await service.create(agent('lead'), { title: 'pilot parent', direction: 'enrolled', openspec_change: 'add-export' })
    const child = await service.create(agent('cl'), { title: 'serializer', direction: 'v1', parent_id: parent.id, openspec_change: 'add-export', worktree: feature })
    // Same group, different session: hierarchy conveys nothing.
    await expect(service.amend(agent('cl2'), child.id, { direction: 'takeover' })).rejects.toThrow('creator')
    await expect(service.setStatus(agent('cl2'), child.id, 'done')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('cl2'), child.id, 'cancelled')).rejects.toThrow('Only the task\'s creator')
    // Within its own rights it coordinates: a new child under the same parent.
    const next = await service.create(agent('cl2'), { title: 'assembly', direction: 'assemble', parent_id: parent.id, openspec_change: 'add-export', worktree: feature })
    expect(next).toMatchObject({ parentId: parent.id, creator: { kind: 'agent', sessionId: 'cl2' } })
    expect((await service.amend(agent('cl2'), next.id, { direction: 'v2' })).revision).toBe(2)
    // The original creator is gone: the replacement still cannot take the child; only the human recovers it.
    records.delete('cl')
    await expect(service.amend(agent('cl2'), child.id, { direction: 'still no' })).rejects.toThrow(/creator/)
    expect(service.store.get(child.id)?.revision).toBe(1)
    expect((await service.amend(human(), child.id, { direction: 'handover direction' })).direction).toBe('handover direction')
    expect((await service.setStatus(human(), child.id, 'cancelled')).status).toBe('cancelled')
  })
})

describe('task tools', () => {
  test('each tool binds the calling session and ignores forged identity fields', async () => {
    const lead = taskHandlers(service, 'lead')
    const dev = taskHandlers(service, 'dev')
    const task = await lead.task_create({ title: 'Export', direction: 'CSV', creator: 'dev', team_id: '/elsewhere', worktree: feature })
    expect(task).toMatchObject({ creator: { kind: 'agent', sessionId: 'lead' }, teamId: team.teamId, worktree: feature })
    await expect(dev.task_create({ title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    await dev.task_note({ task_id: task.id, text: 'started', author: 'lead' })
    await dev.task_update_status({ task_id: task.id, status: 'active' })
    await expect(dev.task_amend({ task_id: task.id, direction: 'mine', session_id: 'lead' })).rejects.toThrow('creator')
    await lead.task_amend({ task_id: task.id, acceptance: 'A file downloads' })
    const full = await dev.task_get({ task_id: task.id })
    expect(full.task).toMatchObject({ status: 'active', revision: 2, acceptance: 'A file downloads' })
    expect(full.journal).toMatchObject([{ text: 'started', author: { kind: 'agent', sessionId: 'dev' } }])
    expect(new Set(full.task.participants)).toEqual(new Set(['lead', 'dev']))
    expect((await dev.task_list({})).tasks.map(row => row.id)).toEqual([task.id])
    expect((await dev.task_list({ status: 'done' })).tasks).toEqual([])
    await expect(dev.task_update_status({ task_id: task.id, status: 'finished' })).rejects.toThrow()
  })
})

describe('task_acknowledge (task-revision-publication 4.2, D6)', () => {
  test('records the calling session once; a repeat is a no-op and pushes nothing', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'v1' })
    const changes: number[] = []
    service.store.subscribe(changed => changes.push(changed.revision))
    const dev = taskHandlers(service, 'dev')
    expect(await dev.task_acknowledge({ task_id: task.id, revision: 1, session_id: 'lead' })).toEqual({ taskId: task.id, revision: 1, alreadyAcknowledged: false })
    expect(await dev.task_acknowledge({ task_id: task.id, revision: 1 })).toMatchObject({ alreadyAcknowledged: true })
    expect(service.store.acknowledgements.list(task.id)).toMatchObject([{ sessionId: 'dev', revision: 1, assignmentId: null }])
    // The detail republishes on the new acknowledgement only.
    expect(changes).toEqual([1])
  })

  test('refuses a revision that is not published, even while a draft of it exists, and another team\'s task', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'v1' })
    await service.saveDraft(human(), task.id, { direction: 'draft of revision 2' })
    await expect(taskHandlers(service, 'dev').task_acknowledge({ task_id: task.id, revision: 2 })).rejects.toThrow('Revision 2 of task')
    await expect(taskHandlers(service, 'stranger').task_acknowledge({ task_id: task.id, revision: 1 })).rejects.toThrow('not found in this team')
    await expect(service.acknowledge(human(), task.id, 1)).rejects.toThrow('Only agents')
    expect(service.store.acknowledgements.list(task.id)).toEqual([])
  })

  test('task_acknowledge is a team tool allowed without an approval card', async () => {
    const { TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
    expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__task_acknowledge')
  })
})

describe('task_amend publishes with rationale and notify (task-revision-publication 4.4, D7)', () => {
  test('the creating lead publishes and notifies: the claimed developer gets one notice from the lead', async () => {
    const { AssignmentStore } = await import('../team/assignmentStore')
    const mail = new MailboxStore(db)
    const assignments = new AssignmentStore(db, mail)
    const notifying = new TaskService(new TaskStore(db, mail, assignments), { getSession: id => records.get(id), homeDir: home })
    const lead = taskHandlers(notifying, 'lead')
    const task = await lead.task_create({ title: 'Export', direction: 'CSV' })
    const { assignment } = assignments.insert({ teamId: team.teamId, taskId: task.id, requestKey: 'assign-1', targetKind: 'session',
      targetId: 'dev', role: 'devs', instruction: 'Build it', creator: { kind: 'human', sessionId: null } })
    const instruction = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev', fromSession: null, fromGroup: null,
      originPath: repo, body: 'Build it', taskId: task.id })
    assignments.setMessage(assignment.id, instruction.id)
    mail.claim(instruction.id, 'dev')
    const published = await lead.task_amend({ task_id: task.id, direction: 'CSV and JSON', rationale: 'Customer asked', notify: true })
    expect(published.revision).toBe(2)
    expect(notifying.store.revisions(task.id).at(-1)).toMatchObject({ rationale: 'Customer asked', notify: true, author: agent('lead') })
    const notices = mail.forTask(task.id).filter(message => message.tags.includes('task-revision'))
    expect(notices).toMatchObject([{ toKind: 'session', toId: 'dev', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: repo,
      revisionNotice: { revision: 2, assignmentId: assignment.id, rationale: 'Customer asked' } }])
    expect(notices[0]!.body).toContain('revision 2 published by lead: Customer asked')
    // A non-creator still cannot: no revision, no notice.
    await expect(taskHandlers(notifying, 'dev').task_amend({ task_id: task.id, direction: 'mine', notify: true })).rejects.toThrow('creator')
    expect(notifying.store.revisions(task.id)).toHaveLength(2)
    expect(mail.forTask(task.id).filter(message => message.tags.includes('task-revision'))).toHaveLength(1)
    assignments.close()
  })
})

describe('spawn-time registration', () => {
  test('the team MCP server carries mailbox and task tools, all allowed without cards', async () => {
    const { createMailboxServer, TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
    const { TeamMailbox } = await import('../team/TeamMailbox')
    const mailbox = new TeamMailbox(new MailboxStore(db), { getSession: id => records.get(id), homeDir: home })
    const { MailboxManagement } = await import('../team/mailboxManagement')
    const management = new MailboxManagement(mailbox.store, { getSession: id => records.get(id), tasks: service, homeDir: home })
    const server = await createMailboxServer(mailbox, 'lead', { tasks: service, management })
    const registered = Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
    const expected = ['send_message', 'reply', 'schedule_message', 'list_groups', 'list_mailbox', 'cancel_message', 'discard_message', 'task_create', 'task_get', 'task_journal_read', 'task_note', 'task_update_status', 'task_amend', 'task_list', 'task_acknowledge']
    expect(registered.sort()).toEqual([...expected].sort())
    // Product strategy (product-strategy 3.2) rides the same allowed list —
    // read/propose only, no approve/publish/withdraw tool anywhere — and so
    // does release_member (member-release D6; registered when a MemberRelease
    // is wired, always allowed).
    // Result tools (task-results-handoffs; task_submit_coverage is
    // independent-verification D6) are allowed too, registered only with a result service;
    // so are the plan tools (durable-plans D11; no approve/withdraw/close/reopen) and the
    // impact tools (strategy-revision-impact D10; read and propose, no decide), and the
    // read-only metrics tool (team-process-metrics D5), and the report tools
    // (team-process-metrics D6; no decide/apply/withdraw/relink/unlink).
    const resultTools = ['task_submit_result', 'task_submit_coverage', 'task_submit_findings', 'task_handoff', 'task_check_result']
    const planTools = ['plan_list', 'plan_get', 'plan_create', 'plan_save_draft', 'plan_submit_for_review']
    // Validation tools (plan-validation D10; validate, read, assess — no decide or approve).
    const validationTools = ['plan_validate', 'plan_validation_get', 'plan_assess']
    expect(TEAM_ALLOWED_TOOLS).toEqual([...expected.slice(0, 7), 'release_member', ...expected.slice(7), ...resultTools, 'strategy_list', 'strategy_get', 'strategy_save_draft', 'strategy_submit_for_review', 'strategy_impact_get', 'strategy_impact_propose', ...planTools, ...validationTools, 'decision_ask', 'decision_record', 'team_metrics',
      'process_report_submit', 'process_reports_list', 'process_report_get', 'process_proposal_link',
      // task_checkpoint (revision-control D7) rides the same allowed list, registered only with a checkpoints service.
      'task_checkpoint', 'team_capacity']
      .map(name => `mcp__kawai-team__${name}`))
    await server.instance.close()
  })
})

describe('status boundary re-check (member-release, MM INFO 4)', () => {
  /** A service whose transition hook pauses until `resume()`, recording each snapshot and closure run. */
  const pausedService = (duringAwait: (store: TaskStore, taskId: string) => void) => {
    const store = new TaskStore(db, new MailboxStore(db))
    const prepared: string[] = []
    const ran: string[] = []
    const paused = new TaskService(store, {
      getSession: id => records.get(id), homeDir: home,
      onStatusTransition: async (task, status) => {
        prepared.push(`${task.status}->${status}`)
        await new Promise(resolve => setImmediate(resolve))
        duringAwait(store, task.id)
        return () => { ran.push(`${task.status}->${status}`) }
      },
    })
    return { store, paused, prepared, ran }
  }

  test('a status change during the hook await is re-read: the boundary is decided on the fresh status', async () => {
    let moved = false
    const { store, paused, prepared, ran } = pausedService((s, id) => {
      if (!moved) { moved = true; s.setStatus(id, 'cancelled') }
    })
    const task = store.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
    store.setStatus(task.id, 'active')
    const done = await paused.setStatus(human(), task.id, 'done', 'shipped')
    // The task was closed (cancelled) while the close hook prepared: cancelled -> done
    // crosses no boundary, so the stale close closure never runs.
    expect(prepared).toEqual(['active->done'])
    expect(ran).toEqual([])
    expect(done.status).toBe('done')
    expect(store.journal(task.id).map(entry => entry.text)).toEqual(['shipped'])
  })

  test('a status that keeps moving is refused as stale, and nothing is written', async () => {
    const { store, paused, ran } = pausedService((s, id) => {
      s.setStatus(id, s.get(id)!.status === 'active' ? 'open' : 'active')
    })
    const task = store.create({ teamId: team.teamId, title: 't', direction: 'd', creator: { kind: 'human', sessionId: null } })
    let refusal = ''
    try { await paused.setStatus(human(), task.id, 'done', 'shipped') } catch (error) { refusal = String(error) }
    expect(refusal).toContain('kept changing status')
    expect(ran).toEqual([])
    expect(store.get(task.id)!.status).not.toBe('done')
    expect(store.journal(task.id)).toEqual([])
  })
})
