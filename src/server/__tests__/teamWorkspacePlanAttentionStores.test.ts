// B3 (review findings): the gatherer and the wiring, over the real stores.
// planAttentionFacts reads open plans through PlanStore/ExecutionStore/
// DecisionStore/IntegrationStore/TaskService — these tests pin the facts the
// per-kind source tests feed by hand: the newest promotion is the cause, a
// correction gates the promotion item, a closed fix task is filtered out,
// leadGroup comes from the approved revision, and a stopped change's row maps
// its taskId and generation. One WorkspaceRead test proves the manager seam
// reaches the snapshot's attention and summary (M5).
import { describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { AttentionItem } from '../../shared/teamWorkspace'
import { normalizePlanContent } from '../../shared/plans'
import {
  planAttentionFacts, type PlanAttentionFact, type PlanAttentionReads,
} from '../team/planAttention'
import { attentionItems, WorkspaceRead, type AttentionInput } from '../team/workspaceRead'
import { DecisionStore } from '../plans/decisions/decisionStore'
import { ExecutionStore } from '../plans/execution/executionStore'
import { IntegrationStore } from '../plans/landing/integration/integrationStore'
import { PlanStore } from '../plans/planStore'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { schemaDb } from './schemaDb'

const items = (facts: PlanAttentionFact[]): AttentionItem[] =>
  attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id,
    pendingAcceptance: [], outboundViolations: [], plans: facts,
  } as unknown as AttentionInput)

const byKind = (items: AttentionItem[], kind: string) => items.filter(item => item.kind === kind)

describe('planAttentionFacts over the real stores: executions, fixes, promotions (B3, 9.2)', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z')
  const FLOOR = { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } }

  const contentOf = (changes: string[], leadGroup: string | null) => normalizePlanContent({
    goal: 'Ship it', successCriteria: ['It ships'],
    changes: changes.map(name => ({ change: name, group: 'middle-devs', dependsOn: [], acceptance: [], extraChecks: [], guidance: '' })),
    roles: leadGroup === null
      ? [{ group: 'middle-devs', profiles: [] }]
      : [{ group: 'middle-devs', profiles: [] }, { group: leadGroup, profiles: [] }],
    ...(leadGroup === null ? {} : { leadGroup }),
    landing: { mode: 'direct' },
  })

  /** A plan with an approved revision over these changes. */
  const approvedPlan = (db: Database, changes: string[], leadGroup: string | null = null): string => {
    const plans = new PlanStore(db)
    const planId = plans.insertPlan({ teamId: 'team', title: 'Wave D', creator: { kind: 'human', sessionId: null } })
    const revision = plans.atomically(() => plans.insertRevision(planId, {
      content: contentOf(changes, leadGroup), contentHash: 'hash', pin: null, author: { kind: 'human', sessionId: null },
    }))
    plans.setRevisionStatus(planId, revision, 'approved')
    plans.setCurrentApproved(planId, revision)
    return planId
  }

  const startExecution = (db: Database, planId: string, changes: string[]) =>
    new ExecutionStore(db).insertExecution({
      teamId: 'team', planId, revision: 1, contentHash: 'hash', reportId: 'report-1', inputHash: 'inputs',
      landingMode: 'direct', baseBranch: 'master', baseCommit: 'base0', floor: FLOOR, maxParallel: 3, mergeMethod: 'merge',
      changes: changes.map(change => ({ change, landed: false })),
    })

  /** Real task records over the schema: the gatherer's reads.tasks.get. */
  const taskService = (db: Database) => {
    const mail = new MailboxStore(db)
    const store = new TaskStore(db, mail, new AssignmentStore(db, mail))
    const tasks = new TaskService(store, { getSession: () => undefined })
    const actor = { kind: 'human' as const, team: { teamId: 'team', groupsRoot: '/repo' } }
    return {
      create: (title: string) => tasks.create(actor, { title, direction: 'd' }),
      close: (taskId: string) => tasks.setStatus(actor, taskId, 'done'),
      get: (taskId: string) => store.get(taskId),
    }
  }

  const readsFor = (db: Database, tasks: ReturnType<typeof taskService>): PlanAttentionReads => ({
    db, mail: new MailboxStore(db),
    runtime: { holder: () => null, blocker: () => null },
    conditionsOf: () => [],
    tasks: { get: taskId => tasks.get(taskId) },
    executions: new ExecutionStore(db), plans: new PlanStore(db), decisions: new DecisionStore(db),
    promotions: new IntegrationStore(db),
  })
  const factsOf = (db: Database, tasks: ReturnType<typeof taskService>) =>
    planAttentionFacts(readsFor(db, tasks), 'team', NOW)

  test('a stopped change maps its row: taskId, generation, and the raised item (M5 path)', () => {
    const db = schemaDb()
    const planId = approvedPlan(db, ['api', 'ui'])
    const execution = startExecution(db, planId, ['api', 'ui'])
    const executions = new ExecutionStore(db)
    executions.transition(execution.id, 'api', { state: 'waiting', generation: 0 },
      { state: 'stopped', stopReason: 'ci-timeout', taskId: 'task-1' })
    executions.transition(execution.id, 'api', { state: 'stopped', generation: 1 }, { state: 'stopped', stopReason: 'ci-timeout' })
    const facts = factsOf(db, taskService(db))
    expect(facts.map(fact => fact.planId)).toEqual([planId])
    expect(facts[0]!.executionId).toBe(execution.id)
    expect(facts[0]!.changes.map(row => [row.supervision.change, row.taskId, row.generation])).toEqual([
      ['api', 'task-1', 2],
      ['ui', null, 0],
    ])
    // The gathered fact raises the stopped item through the real derivation.
    expect(byKind(items(facts), 'plan-stop').map(item => item.id)).toEqual([`plan-stop:${execution.id}:api:2`])
  })

  test('leadGroup comes from the approved revision (M4)', () => {
    const db = schemaDb()
    const led = approvedPlan(db, ['api'], 'lead')
    const unled = approvedPlan(db, ['docs'])
    const facts = factsOf(db, taskService(db))
    expect(facts.find(fact => fact.planId === led)!.leadGroup).toBe('lead')
    expect(facts.find(fact => fact.planId === unled)!.leadGroup).toBeNull()
  })

  test('an open fix task raises a fact; a closed one is filtered out (M3)', async () => {
    const db = schemaDb()
    const planId = approvedPlan(db, ['api'])
    const tasks = taskService(db)
    const decisions = new DecisionStore(db)
    const override = (question: string) => {
      const cardId = decisions.insertCard({
        teamId: 'team', planId, revision: null, change: null, taskId: null, question, options: [], context: null,
        askedBy: { session: 'chat-dev', group: 'middle-devs', profile: 'glm' },
        addressedTo: 'owner', addressedGroup: null, messageId: null,
      }).id
      return decisions.insertDecision({
        cardId, planId, teamId: 'team', seq: 1, kind: 'override', choice: 'Reconsider', optionIndex: null, rationale: 'wrong call',
        decidedBy: { kind: 'human', session: null, group: null, profile: null }, affected: [],
      }).id
    }
    const openFix = await tasks.create('Forward fix: schema')
    decisions.insertFixTask({ teamId: 'team', planId, sourceKind: 'override', sourceId: override('Which schema?'), taskId: openFix.id })
    const closedFix = await tasks.create('Forward fix: old')
    decisions.insertFixTask({ teamId: 'team', planId, sourceKind: 'override', sourceId: override('Which index?'), taskId: closedFix.id })
    await tasks.close(closedFix.id)
    const fact = factsOf(db, tasks).find(f => f.planId === planId)!
    expect(fact.fixes.map(fix => [fix.taskId, fix.title])).toEqual([[openFix.id, 'Forward fix: schema']])
    expect(byKind(items([fact]), 'plan-fix').map(item => item.id)).toEqual([`plan-fix:${openFix.id}`])
    // Closing it clears the item (its cause is gone; the monitor closes the task).
    await tasks.close(openFix.id)
    const closed = factsOf(db, tasks).find(f => f.planId === planId)!
    expect(closed.fixes).toEqual([])
    expect(byKind(items([closed]), 'plan-fix')).toEqual([])
  })

  test('the newest failed promotion is the cause; a newer started promotion clears it (M2)', () => {
    const db = schemaDb()
    const planId = approvedPlan(db, ['api'])
    const integrations = new IntegrationStore(db)
    const promote = (fromSha: string, commandId: string) => integrations.insertPromotion({
      teamId: 'team', planId, branch: 'feat/one', commandId, fromSha, throughSeq: 0, targetBranch: 'master', floor: {},
    })
    const first = promote('a'.repeat(40), 'cmd-1')
    integrations.finishPromotion(first.id, 'failed:ci-failed', null)
    let facts = factsOf(db, taskService(db))
    expect(facts[0]!.failedPromotion).toMatchObject({ id: first.id, targetBranch: 'master', reason: 'ci-failed' })
    expect(facts[0]!.correctionOpen).toBe(false)
    expect(byKind(items(facts), 'plan-promotion')).toHaveLength(1)
    // A later promotion has started: the failed one is no longer the newest.
    promote('b'.repeat(40), 'cmd-2')
    facts = factsOf(db, taskService(db))
    expect(facts[0]!.failedPromotion).toBeNull()
    expect(byKind(items(facts), 'plan-promotion')).toEqual([])
  })

  test('two finished promotions: the newest is the cause (M2)', () => {
    const db = schemaDb()
    const planId = approvedPlan(db, ['api'])
    const integrations = new IntegrationStore(db)
    const first = integrations.insertPromotion({ teamId: 'team', planId, branch: 'feat/one', commandId: 'cmd-1', fromSha: 'a'.repeat(40), throughSeq: 0, targetBranch: 'master', floor: {} })
    integrations.finishPromotion(first.id, 'failed:ci-failed', null)
    const second = integrations.insertPromotion({ teamId: 'team', planId, branch: 'feat/one', commandId: 'cmd-2', fromSha: 'b'.repeat(40), throughSeq: 0, targetBranch: 'master', floor: {} })
    integrations.finishPromotion(second.id, 'failed:promotion-conflict', null)
    const fact = factsOf(db, taskService(db))[0]!
    expect(fact.failedPromotion).toMatchObject({ id: second.id, reason: 'promotion-conflict' })
    expect(byKind(items([fact]), 'plan-promotion').map(item => item.id)).toEqual([`plan-promotion:${second.id}`])
  })

  test('the promotion item waits while its correction is open and returns when it closes (M1)', async () => {
    const db = schemaDb()
    const planId = approvedPlan(db, ['api'])
    const integrations = new IntegrationStore(db)
    const failed = integrations.insertPromotion({ teamId: 'team', planId, branch: 'feat/one', commandId: 'cmd-1', fromSha: 'a'.repeat(40), throughSeq: 0, targetBranch: 'master', floor: {} })
    integrations.finishPromotion(failed.id, 'failed:ci-failed', null)
    const tasks = taskService(db)
    const correction = await tasks.create('Correct failed promotion: ci-failed — Wave D')
    new DecisionStore(db).insertFixTask({ teamId: 'team', planId, sourceKind: 'promotion', sourceId: failed.id, taskId: correction.id })
    let facts = factsOf(db, tasks)
    expect(facts[0]!.failedPromotion).toMatchObject({ id: failed.id })
    expect(facts[0]!.correctionOpen).toBe(true)
    expect(byKind(items(facts), 'plan-promotion')).toEqual([])
    await tasks.close(correction.id)
    facts = factsOf(db, tasks)
    expect(facts[0]!.correctionOpen).toBe(false)
    expect(byKind(items(facts), 'plan-promotion')).toHaveLength(1)
  })
})

describe('WorkspaceRead.snapshot carries the plan facts (B3, 9.2/9.3 wiring)', () => {
  const planFacts: PlanAttentionFact[] = [{
    teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: null, executionId: 'exec-1',
    changes: [{
      taskId: 'task-1', generation: 0,
      supervision: {
        change: 'api', outcome: 'stopped',
        cause: { kind: 'stopped', reason: 'ci-timeout', detail: null },
        alsoApplying: [], stage: null, holder: null, progress: null, activity: null, stall: null, landing: null, lastRound: null,
      },
    }],
    openCards: [], fixes: [], failedPromotion: null, correctionOpen: false,
  }]
  const planRows = { landings: [], stops: [{ planId: 'plan-1', planTitle: 'Wave D', change: 'api', stoppedAt: '2026-10-20T10:00:00.000Z', reason: 'ci-timeout' }], stallAlerts: [], decisions: [], overrides: [] }

  test('the manager seam plan facts reach the snapshot attention and summary (M5)', () => {
    const manager = {
      tasks: { store: {
        list: () => [], get: () => null,
        results: { get: () => null, outstandingSince: () => [], submittedBy: () => false },
        acknowledgements: { highest: () => null },
      } },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } },
      waitingFor: () => ({}),
      teamRecords: () => [],
      directory: { list: () => [] },
      getPendingRequests: () => [],
      teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}),
      teamApprovalDefault: () => null,
      turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [],
      outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
      planAttentionFacts: (teamId: string) => (teamId === 'team' ? planFacts : []),
      planSummaryRows: (teamId: string) => (teamId === 'team' ? planRows : { landings: [], stops: [], stallAlerts: [], decisions: [], overrides: [] }),
    }
    const snapshot = new WorkspaceRead(manager as never).snapshot({ teamId: 'team' } as never)
    expect(snapshot.attention.map(item => item.id)).toEqual(['plan-stop:exec-1:api:0'])
    expect(snapshot.summary.stops.items.map(item => item.id)).toEqual(['stop:plan-1:api:2026-10-20T10:00:00.000Z'])
    // Another team reads neither.
    const other = new WorkspaceRead(manager as never).snapshot({ teamId: 'other' } as never)
    expect(other.attention).toEqual([])
    expect(other.summary.stops.items).toEqual([])
  })
})
