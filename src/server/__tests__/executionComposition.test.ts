// The composition tests (plan-execution rev 3): everything goes through
// `composePlanServices` over the plan bench — the same construction the
// manager runs — never a hand-built executor. A local bare origin behind a
// GitHub-shaped remote, a stub gh on a private PATH, and the real git and
// round adapters prove: Start dispatches the first implement attempt; an
// owned task's manual assign and accept are refused; a submitted result
// advances without the timer through push, PR, and green CI to the review
// handoff, which releases the spawned implementer before dispatching the
// review; boot runs recovery and clears orphan landing slots before any
// tick; the default composition carries the real adapters; the D5 wakes
// fire only for owned tasks; and stop leaves nothing behind.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { MemberRelease } from '../team/memberRelease'
import { TeamMailbox } from '../team/TeamMailbox'
import type { PlanService } from '../plans/PlanService'
import type { DecisionService } from '../plans/decisions/DecisionService'
import type { SupervisionMonitor } from '../plans/supervision/SupervisionMonitor'
import { TaskService } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TeamWorktrees } from '../team/worktreeRoots'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { ImpactService } from '../strategy/ImpactService'
import { ImpactStore } from '../strategy/impactStore'
import { composeExecutionCore, composePlanServices, type ExecutionCore } from '../plans/planComposition'
import { pauseHolderFacts } from '../plans/revisionControl/pauseTick'
import type { ExecutionRuntime } from '../plans/execution/executionRuntime'
import type { ExecutionStore } from '../plans/execution/executionStore'
import { roundAdapters } from '../plans/execution/executionRounds'
import type { ExecutionService } from '../plans/execution/ExecutionService'
import { ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { LEAD_ROLES } from './decisionHarness'
import { createPlanBench, createPlanWorld, sessionRow, writeGroup, type PlanBench, type PlanWorld } from './planHarness'

const FLOOR = { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] }
const GITHUB_URL = 'https://github.com/acme/app.git'
/** One change name per test: the probe's name check sees earlier tests' worktrees and branches. */
const CHANGES = ['ship-a', 'ship-b', 'ship-c', 'ship-d', 'ship-e', 'ship-f', 'ship-g', 'ship-h']
let changeSerial = 0
const nextChange = (): string => CHANGES[changeSerial++ % CHANGES.length]!

let world: PlanWorld
let bench: PlanBench
let core: ExecutionCore
let mail: MailboxStore
let tasks: TaskService
let assignments: AssignmentService
let results: TaskResultService
let releases: MemberRelease
let store: ExecutionStore
let service: ExecutionService
let runtime: ExecutionRuntime
let teamMailbox: TeamMailbox
let composedPlans: PlanService
let decisions: DecisionService | null
let monitor: SupervisionMonitor | null
let main: string
let origin: string
let baseSha: string
let archived: string[]

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}
const commitAll = (cwd: string, message: string) => {
  git(['add', '-A'], cwd)
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '-m', message], cwd)
}

/** The stub gh's private bin, answering exactly what the composed path asks. */
let ghBin: string

function writeGhStub(treeFile: string) {
  fs.mkdirSync(ghBin, { recursive: true })
  fs.writeFileSync(path.join(ghBin, 'gh'), `#!/bin/sh
case "$*" in
  *"auth status"*) exit 0 ;;
  *check-runs*) printf '%s' '[{"check_runs":[{"name":"ci","status":"completed","conclusion":"success","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"},{"name":"e2e","status":"completed","conclusion":"success","started_at":"2026-01-01T00:00:00Z","completed_at":"2026-01-01T00:00:01Z"}]}]' ;;
  *"/status"*) printf '%s' '{"statuses":[]}' ;;
  *"git/trees/"*) cat "${treeFile}" ;;
  *"git/commits/"*) printf '%s' '{"tree":{"sha":"ttt-0000"}}' ;;
  *"POST repos/acme/app/pulls "*) printf '%s' '{"number":7,"url":"https://api.example.internal/repos/acme/app/pulls/7","html_url":"https://example.internal/pr/7"}' ;;
  *"pr list"*) printf '%s' '[]' ;;
  *"repos/acme/app"*) printf '%s' '{"default_branch":"master","permissions":{"push":true}}' ;;
  *) echo "gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
}

/** The composed stack over the bench: core, team services with the ownership, and the runtime. */
async function compose(): Promise<void> {
  core = composeExecutionCore(bench.db.db)
  mail = (bench.tasks as unknown as { mail: MailboxStore }).mail
  tasks = new TaskService(bench.tasks, {
    getSession: id => bench.records.get(id), homeDir: world.home,
    restoreSession: () => undefined, plans: bench.plans, ownership: core.ownership,
  })
  releases = new MemberRelease(bench.db.db, {
    store: mail, tasks: bench.tasks,
    records: () => bench.records.values(), getRecord: id => bench.records.get(id),
    teamOf: id => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team),
    definition: async () => undefined, cachedDefinition: () => undefined,
    recipient: () => undefined,
    hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
    archive: id => {
      const record = bench.records.get(id)
      if (!record) return { ok: false, error: `no record ${id}` }
      bench.records.set(id, { ...record, archivedAt: new Date().toISOString() })
      archived.push(id)
      return { ok: true }
    },
    notify: () => undefined,
  })
  const caps = new TeamCaps({ homeDir: world.home })
  const worktrees = new TeamWorktrees()
  const teamOf = (id: string) => (bench.records.get(id)?.projectPath === world.other ? undefined : world.team)
  const staffing = new WorktreeStaffing(bench.db.db, mail, {
    records: () => bench.records.values(), teamOf, caps, worktrees,
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  assignments = new AssignmentService(bench.db.db, new AssignmentStore(bench.db.db, mail), bench.tasks, mail, {
    getSession: id => bench.records.get(id), records: () => bench.records.values(), teamOf,
    staffing, caps, worktrees, homeDir: world.home, plans: bench.plans, ownership: core.ownership,
  })
  results = new TaskResultService(tasks, {
    getSession: id => bench.records.get(id), assignments,
    releases, records: () => bench.records.values(), homeDir: world.home,
    ownership: core.ownership, onWrite: taskId => core.wakes.resultWrite(taskId),
  })
  const impact = new ImpactService(new ImpactStore(bench.db.db), {
    strategies: bench.strategies, plans: bench.plans, mail, getSession: id => bench.records.get(id),
  })
  teamMailbox = new TeamMailbox(mail, { getSession: id => bench.records.get(id), homeDir: world.home, tasks: bench.tasks })
  const composed = composePlanServices({
    db: bench.db.db, plans: bench.plans, strategies: bench.strategies, impact,
    getSession: id => bench.records.get(id),
    caps: { planExecution: async () => ({ floorChecks: FLOOR, maxParallelChanges: 2, mergeMethod: 'merge' }) },
    executionCore: core,
    executionTeam: {
      tasks, assignments, results, taskStore: bench.tasks, mailbox: mail, teamMailbox, releases,
      pendingSpawns: () => [],
      records: () => bench.records.values(),
      // The executor resolves by team id; the runtime's archive wake by session.
      identityOf: id => (id === world.team.teamId ? world.team : undefined),
      teamOfSession: teamOf,
      supervision: { holder: () => null, blocker: () => null },
      // The pause tick's holder facts (revision-control D8): bench records,
      // nothing pending or busy, no provider limit.
      pauseFacts: pauseHolderFacts({
        getRecord: id => bench.records.get(id),
        pendingRequest: () => false, hasLiveWorkers: () => false, hasRunningBackgroundTasks: () => false,
        parkedResumes: () => [], cooldownUntil: () => null,
      }),
    },
    executionValidation: {
      prepareStanding: async () => ({}),
      standing: () => ({ state: 'current', report: { id: 'rep-1', inputHash: 'ih-1', readiness: { carriedConditions: [] } } }) as never,
    },
    executionGhOptions: { env: { PATH: `${ghBin}${path.delimiter}${process.env.PATH ?? ''}` } },
  })
  store = composed.executionStore
  service = composed.executions
  decisions = composed.decisions
  monitor = composed.monitor
  composedPlans = composed.plans
  runtime = composed.runtime!
  await runtime.start()
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-exec-comp-')
  writeGroup(world, 'middle-devs', '---\nmax: 2\n---\nBuild.')
  writeGroup(world, 'reviewers', '---\nmax: 2\n---\nReview.')
  // The team's main checkout (the bench team's groups root) carries the
  // GitHub-shaped origin the probe reads, rewritten to a local bare.
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-exec-comp-git-'))
  origin = path.join(gitRoot, 'origin.git')
  main = world.repo
  git(['init', '-q', '--bare', '-b', 'master', origin], gitRoot)
  for (const change of CHANGES) {
    fs.mkdirSync(path.join(main, 'openspec', 'changes', change), { recursive: true })
    fs.writeFileSync(path.join(main, 'openspec', 'changes', change, 'proposal.md'), `# ${change}\n`)
  }
  commitAll(main, 'changes')
  git(['remote', 'add', 'origin', origin], main)
  git(['push', '-q', 'origin', 'master'], main)
  baseSha = git(['rev-parse', 'master'], origin).trim()
  git(['remote', 'set-url', 'origin', GITHUB_URL], main)
  git(['config', `url.${origin}.insteadOf`, GITHUB_URL], main)
  // The stub gh's tree mirrors origin's master, so the probe's real
  // changes-on-base comparison sees equal content.
  const entries = git(['ls-tree', '-r', 'HEAD'], main).trim().split('\n').map(line => {
    const [meta, file] = line.split('\t')
    const sha = meta!.split(' ')[2]!
    return `{ "path": "${file}", "sha": "${sha}", "type": "blob" }`
  })
  ghBin = path.join(world.root, 'bin')
  fs.mkdirSync(ghBin, { recursive: true })
  fs.writeFileSync(path.join(ghBin, 'trees.json'), `{ "tree": [${entries.join(', ')}] }`)
  writeGhStub(path.join(ghBin, 'trees.json'))
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))

beforeEach(async () => {
  bench?.db.close()
  bench = createPlanBench(world)
  archived = []
  await compose()
})
afterEach(() => runtime.stop())

/** Approve a one-change plan over the repo's base; the human Start runs against it. */
async function startedExecution(change: string): Promise<string> {
  const { planId, revision, hash } = await bench.draftInReview({
    changes: [{ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' }],
    reviewGroup: 'reviewers',
  })
  await bench.approve(planId, revision)
  const started = await service.start(bench.human, { planId, revision, contentHash: hash, commandId: `start-${change}` })
  if (!started.ok) throw new Error(`start refused: ${started.message}`)
  await runtime.idle()
  return started.execution.id
}

/** A spawned implementer works in the change's worktree and submits a result. */
async function implement(executionId: string, change: string): Promise<{ taskId: string; resultId: string }> {
  const row = store.change(executionId, change)!
  bench.records.set('impl', { ...sessionRow('impl', 'middle-devs', row.worktree!), spawned: true, taskId: row.taskId ?? null })
  fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
  fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'export = 1\n')
  commitAll(row.worktree!, `implement ${change}`)
  git(['push', '-q', 'origin', `HEAD:refs/heads/${change}`], row.worktree!)
  const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
  const result = await results.submit(bench.agent('impl'), row.taskId!, { summary: 'done', commit, tests: [{ description: 'unit', outcome: 'pass' }] })
  // The result write woke the executor (D5): the round forms without the timer.
  await runtime.idle()
  runtime.command(world.team.teamId)
  await runtime.idle()
  return { taskId: row.taskId!, resultId: result.id }
}

describe('the composed execution stack (rev 3)', () => {
  // revision-control D2: seq 1 is the revision Start recorded; the migration's
  // backfill covers executions started before migration 17.
  test('Start writes the seq-1 revision row in its transaction; a replay writes none and record takes seq 2', async () => {
    const change = nextChange()
    const { planId, revision, hash } = await bench.draftInReview({
      changes: [{ change, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' }],
      reviewGroup: 'reviewers',
    })
    await bench.approve(planId, revision)
    const started = await service.start(bench.human, { planId, revision, contentHash: hash, commandId: `start-${change}` })
    if (!started.ok) throw new Error(`start refused: ${started.message}`)
    const execution = store.execution(started.execution.id)!
    const revisions = new ExecutionRevisionStore(bench.db.db)
    expect(revisions.history(started.execution.id)).toEqual([{
      executionId: started.execution.id, seq: 1, revision: execution.revision, contentHash: execution.contentHash,
      reportId: execution.reportId, inputHash: execution.inputHash, rationale: null, commandId: null,
      payload: null, appliedAt: execution.startedAt,
    }])
    // A replayed Start replays through the plan event and writes no second row (R17).
    const replay = await service.start(bench.human, { planId, revision, contentHash: hash, commandId: `start-${change}` })
    expect(replay.ok && replay.replayed).toBe(true)
    expect(revisions.history(started.execution.id)).toHaveLength(1)
    // The next revision appends at seq 2.
    const next = revisions.record({ executionId: started.execution.id, revision, contentHash: hash, reportId: execution.reportId, inputHash: execution.inputHash, appliedAt: execution.startedAt, rationale: 'apply', commandId: 'apply-tbl', payload: null }, [])
    expect(next.seq).toBe(2)
  })
  test('the default composition carries the real adapters', () => {
    expect(runtime.adapters.fixture).toBe(false)
    expect(runtime.adapters.rounds).toBe(roundAdapters)
  })

  test('the composed decision service writes through the team mailbox and announces the plan (plan-supervision 6.1)', async () => {
    expect(decisions!.deps.mailbox).toBe(teamMailbox)
    const { planId, revision } = await bench.draftInReview(LEAD_ROLES)
    await bench.approve(planId, revision)
    const announced: string[] = []
    const unsubscribe = bench.plans.subscribe(plan => announced.push(plan.id))
    try {
      const { card } = await decisions!.ask({ kind: 'agent', sessionId: 'lead' }, { question: 'Ship now?', plan_id: planId })
      expect(card).toMatchObject({ planId, addressedTo: 'owner' })
      expect(announced).toEqual([planId])
    } finally {
      unsubscribe()
    }
  })

  test("the composed detail carries decisions, supervision, and usage; a fix task's status re-pushes it (plan-supervision 6.3, 7.2)", async () => {
    const { planId, revision } = await bench.draftInReview(LEAD_ROLES)
    await bench.approve(planId, revision)
    const { card } = await decisions!.ask({ kind: 'agent', sessionId: 'lead' }, { question: 'Ship now?', options: ['yes', 'no'], plan_id: planId })
    const decided = await decisions!.answer(bench.human, { planId, cardId: card.id, optionIndex: 1, commandId: 'c-ans' })
    const overridden = await decisions!.override(bench.human, { planId, cardId: card.id, expectedDecisionId: decided.decision.id, optionIndex: 2, rationale: 'not yet', commandId: 'c-ovr' })
    const detail = composedPlans.detailWithExecutions(planId)
    expect(detail.decisions!.map(view => [view.card.id, view.state])).toEqual([[card.id, 'overridden']])
    expect(detail.decisions![0]!.fixes[0]).toMatchObject({ taskId: overridden.fixTaskId, status: { phase: 'planning' } })
    expect(detail.supervision!.changes.map(entry => entry.outcome)).toEqual(detail.supervision!.changes.map(() => 'not-started'))
    expect(detail.usage).toBeDefined()
    const announced: string[] = []
    const unsubscribe = bench.plans.subscribe(plan => announced.push(plan.id))
    try {
      bench.tasks.setStatus(overridden.fixTaskId!, 'cancelled')
      expect(announced).toEqual([planId])
      expect(composedPlans.detailWithExecutions(planId).decisions![0]!.fixes[0]!.status.phase).toBe('cancelled')
      announced.length = 0
      // An ordinary task's change announces nothing through the fix rule.
      const other = bench.tasks.create({ teamId: world.team.teamId, title: 'other', direction: 'd', creator: { kind: 'human' } } as never)
      bench.tasks.setStatus(other.id, 'active')
      expect(announced).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  test('the composition carries the supervision monitor; its startup seeds the running changes it sweeps (plan-supervision 8.2)', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    expect(monitor).not.toBeNull()
    expect(monitor!.waitEndedAt(executionId, change)).toBeNull()
    monitor!.start()
    try {
      expect(monitor!.waitEndedAt(executionId, change)).not.toBeNull()
      await monitor!.idle()
      expect(monitor!.timerArmed(world.team.teamId)).toBe(true)
    } finally {
      monitor!.stop()
    }
    expect(monitor!.timerArmed(world.team.teamId)).toBe(false)
  })

  test('Start leads to the first implement dispatch', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    const row = store.change(executionId, change)!
    // Provision ran over the real origin: a worktree cloned from the base.
    expect(row.state).toBe('implementing')
    expect(fs.existsSync(path.join(row.worktree!, 'openspec', 'changes', change, 'proposal.md'))).toBe(true)
    // Kawai's task, its manifest, and the dispatched implement instruction.
    expect(row.taskId).not.toBeNull()
    const task = bench.tasks.get(row.taskId!)
    expect(task?.creator.kind).toBe('system')
    const dispatch = bench.tasks.assignmentsOf(row.taskId!).at(-1)!
    expect(dispatch.handoffKind).toBeNull()
    expect(mail.get(dispatch.messageId!)).toMatchObject({ toKind: 'group', toId: 'middle-devs', state: 'queued' })
    expect(store.attempts(executionId, change).at(-1)).toMatchObject({ kind: 'implement' })
  })

  test('a manual assign of an owned task is refused; a human accept closes it and stops the change unmerged', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    const { taskId, resultId } = await implement(executionId, change)
    const assignmentsBefore = tasks.store.assignmentsOf(taskId).length
    await expect(assignments.dispatch(bench.human, {
      taskId, target: { kind: 'session', id: 'stranger' }, instruction: 'take it over', requestKey: 'manual-1',
    })).rejects.toThrow('owned by a running execution')
    await expect(assignments.dispatch(bench.agent('impl'), {
      taskId, target: { kind: 'session', id: 'stranger' }, instruction: 'take it over', requestKey: 'manual-2',
    })).rejects.toThrow('owned by a running execution')
    expect(tasks.store.assignmentsOf(taskId)).toHaveLength(assignmentsBefore)
    // An agent is refused by the creator rule: Kawai created the task.
    await expect(results.accept(bench.agent('impl'), taskId, resultId)).rejects.toThrow("Only the task's creator")
    // The human accept closes the task (spec: Accepting by hand closes without landing).
    const accepted = await results.accept(bench.human, taskId, resultId)
    expect(accepted.task.status).toBe('done')
    await runtime.idle()
    const planId = store.execution(executionId)!.planId
    expect(store.change(executionId, change)).toMatchObject({ state: 'stopped', stopReason: 'task-closed' })
    expect(store.landings(planId)).toEqual([])
    expect(store.effectsOf(executionId).some(effect => effect.kind === 'merge')).toBe(false)
    expect(tasks.store.list(world.team.teamId).filter(task => task.planChange === change)).toHaveLength(1)
  })

  test('an owned result advances without the timer and releases the implementer before the review', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    const { taskId } = await implement(executionId, change)
    const row = store.change(executionId, change)!
    // The result write's wake ran the pipeline: push, the change's one PR,
    // green CI — all through the real adapters and the stub gh.
    expect(row.prNumber).toBe(7)
    expect(row.state).toBe('gating')
    // The spawned implementer was released (member release's archive), and
    // only then the review handoff dispatched to the reviewers.
    expect(archived).toContain('impl')
    const review = bench.tasks.assignmentsOf(taskId).find(assignment => assignment.handoffKind === 'review')
    expect(review).toBeDefined()
    expect(mail.get(review!.messageId!)).toMatchObject({ toId: 'reviewers' })
  }, 20000)

  test('boot: recovery settles a running effect, orphan slots clear, and the running team wakes', async () => {
    const bootChange = nextChange()
    // Rows a restart left behind: a running execution whose change entered
    // landing (its slot is live), an orphan slot row, and a running effect.
    const { planId, revision, hash } = await bench.draftInReview({
      changes: [{ change: bootChange, dependsOn: [], group: 'middle-devs', acceptance: [], extraChecks: [], guidance: '' }],
      reviewGroup: 'reviewers',
    })
    await bench.approve(planId, revision)
    const executionId = store.insertExecution({
      teamId: world.team.teamId, planId, revision, contentHash: hash, reportId: 'r', inputHash: 'i',
      landingMode: 'direct', baseBranch: 'master', baseCommit: baseSha, floor: { version: 1, map: FLOOR },
      maxParallel: 2, mergeMethod: 'merge', changes: [{ change: bootChange, landed: false }],
    }).id
    // One landing slot per team: the orphan row a crash left behind, its
    // holder change gone — the live-holder case lives in the store's tests.
    bench.db.db.prepare("INSERT INTO plan_landing_slots (team_id, holder_kind, holder_id, since) VALUES (?, 'change', ?, ?)")
      .run(world.team.teamId, `${executionId}:gone-change`, '2026-01-01T00:00:00.000Z')
    const effect = store.insertEffect({
      executionId, change: bootChange, roundId: null, kind: 'merge',
      effectKey: `${executionId}:${bootChange}:merge:1:1`, command: { repo: 'acme/app', pr: 7, method: 'merge', head: baseSha },
    })
    bench.db.db.prepare('UPDATE plan_execution_effects SET state = ? WHERE id = ?').run('running', effect.id)

    // A fresh composition over the same rows is the restart: its boot runs
    // recovery to its end, clears the orphan slot, then wakes the team.
    runtime.stop()
    await compose()
    // The boot wake's tick runs after recovery; the effect settles out of
    // the pre-restart `running` state either way (inspected, re-run, failed).
    await runtime.idle()
    expect(store.effect(effect.id)!.state).not.toBe('running')
    expect(store.slot(world.team.teamId)).toBeNull()
    // The boot wake dispatched the implement attempt with no command at all.
    await runtime.idle()
    const row = store.change(executionId, bootChange)!
    expect(bench.tasks.assignmentsOf(row.taskId ?? '')).toHaveLength(1)
  }, 20000)

  test('the release step reads group scoping through the team identity, with no live member (N7)', () => {
    writeGroup(world, 'free-devs', '---\nworktreeScoped: false\n---\nAnywhere.')
    try {
      // Nobody of either group is live: the read goes through identityOf.
      const live = [...bench.records.values()].filter(record => record.groupId === 'free-devs' || record.groupId === 'reviewers')
      expect(live).toEqual([])
      const groupScoped = (runtime as unknown as { deps: { executor: { deps: { groupScoped: (teamId: string, groupId: string) => boolean } } } })
        .deps.executor.deps.groupScoped
      expect(groupScoped(world.team.teamId, 'free-devs')).toBe(false)
      expect(groupScoped(world.team.teamId, 'reviewers')).toBe(true)
      // An unknown team counts as scoped.
      expect(groupScoped('no-such-team', 'free-devs')).toBe(true)
    } finally {
      fs.rmSync(path.join(world.repo, '.kawai', 'groups', 'free-devs.md'), { force: true })
    }
  })

  test('the D5 wakes fire only for owned tasks', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    const ownedTaskId = store.change(executionId, change)!.taskId!
    const woken: string[] = []
    core.wakes.bind({ wake: (teamId: string) => woken.push(teamId), sessionArchived: () => woken.push('archived') })
    // An unowned task's result write wakes nothing.
    core.wakes.resultWrite('task-that-is-not-owned')
    expect(woken).toEqual([])
    core.wakes.resultWrite(ownedTaskId)
    expect(woken).toEqual([world.team.teamId])
    core.wakes.archived('nobody')
    expect(woken).toEqual([world.team.teamId, 'archived'])
    // Stop unbinds the hub: nothing more wakes.
    runtime.stop()
    core.wakes.resultWrite(ownedTaskId)
    core.wakes.archived('nobody')
    expect(woken).toEqual([world.team.teamId, 'archived'])
    core.wakes.bind(null)
  })

  test('stop refuses new ticks and leaves no timers behind', async () => {
    const change = nextChange()
    const executionId = await startedExecution(change)
    runtime.stop()
    // A result write after stop wakes nothing: the row does not advance.
    const row = store.change(executionId, change)!
    const before = row.state
    bench.records.set('impl2', { ...sessionRow('impl2', 'middle-devs', row.worktree!), spawned: true, taskId: row.taskId ?? null })
    fs.mkdirSync(path.join(row.worktree!, 'src'), { recursive: true })
    fs.writeFileSync(path.join(row.worktree!, 'src', `${change}.ts`), 'export = 2\n')
    commitAll(row.worktree!, 'second')
    git(['push', '-q', 'origin', `HEAD:refs/heads/${change}`], row.worktree!)
    const commit = git(['rev-parse', 'HEAD'], row.worktree!).trim()
    await results.submit(bench.agent('impl2'), row.taskId!, { summary: 'more', commit })
    expect(store.change(executionId, change)!.state).toBe(before)
  })
})
