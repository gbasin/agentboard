// The round pipeline's release step end to end (plan-execution §12.4, D11)
// over the plan bench, a bare origin, and a stub gh: a worktree-scoped
// review group releases the spawned implementer before the review handoff —
// and holds the step, with its reason, while the member is not ready or a
// spawn is still starting in the worktree, releasing it and dispatching the
// review on the next tick once it can be released. The return to the
// implementer also releases ready reviewers, retrying refused archives and
// rebuilding the cleanup from stored state after an executor restart.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import path from 'node:path'
import type { ActiveHold } from '../../shared/planRevisionControl'
import { ExecutionExecutor } from '../plans/execution/executor'
import { provisionAdapter } from '../plans/execution/executionProvision'
import { neutralExecutorSeams } from './executorTestSeams'
import {
  approvedExecution, assignments, bench, closeExecutor, deliverToReviewer, executions, ghStub, implementStage, mail, passCi,
  results, setupBench, setupWorld, stubRoundAdapters, tasks, teardownWorld, world,
} from './executionRoundsFixture'

beforeAll(setupWorld)
afterAll(teardownWorld)
beforeEach(setupBench)
afterEach(closeExecutor)

describe('a finished reviewer gives the worktree back', () => {
  /** A change whose review just failed, with a reviewer record in its worktree and a recording executor. */
  const failedReview = async (name: string, reviewer: { spawned: boolean }, options: { scoped?: boolean } = {}) => {
    const executionId = await approvedExecution(name)
    const staged = await implementStage(executionId, name, 'x')
    const worktree = staged.row!.worktree!
    const released: Array<{ id: string; detail: string | undefined }> = []
    const holding = { ready: true, reason: null as string | null }
    const hold = { on: false }
    const archive = { refused: false }
    const createExecutor = () => new ExecutionExecutor({
      ...neutralExecutorSeams, plansService: bench.service,
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: {
        readiness: id => (id === 'rev1' ? holding : { ready: true, reason: null }),
        release: (id, detail) => {
          released.push({ id, detail })
          if (archive.refused) return { ok: false as const, error: 'archive refused' }
          // The real release archives, so a later pass finds no live member.
          bench.records.set(id, { ...bench.records.get(id)!, archivedAt: '2026-11-05T00:00:00.000Z' })
          return { ok: true as const }
        },
        pendingSpawns: () => [],
      },
      groupScoped: () => options.scoped !== false,
      holds: {
        active: () => (hold.on ? [{ id: 'hold-1', scope: 'plan', changes: [] } as unknown as ActiveHold] : []),
        openTargets: () => [],
      },
    })
    const recording = createExecutor()
    ghStub.pulls = '[]'
    passCi()
    recording.wake(world.team.teamId)
    await recording.idle()
    const change = executions.change(executionId, name)!
    const round = executions.rounds(executionId, name).at(-1)!
    const assignment = tasks.store.assignmentsOf(change.taskId!).find(row => row.id === round.reviewAssignmentId)!
    bench.records.set('rev1', { ...bench.records.get('rev1')!, projectPath: worktree, spawned: reviewer.spawned, taskId: change.taskId, archivedAt: null })
    deliverToReviewer(assignment.messageId!, 'rev1')
    released.length = 0
    return { executionId, change, round, released, holding, hold, archive, recording, createExecutor }
  }
  const fail = (change: { taskId: string | null }, round: { resultId: string }) =>
    results.submitFindings(bench.agent('rev1'), change.taskId!, { resultId: round.resultId, kind: 'review', verdict: 'fail', findings: 'a real defect' })

  // @covers: plan-execution › A worktree-scoped review group gets the worktree › A finished reviewer gives the worktree back
  test('a failed review releases the reviewer once it is ready, and only the reviewer', async () => {
    const { executionId, change, round, released, holding, recording } = await failedReview('give-a', { spawned: true })
    try {
      // The reviewer is still finishing the turn that submitted its findings.
      holding.ready = false
      holding.reason = 'it is busy'
      await fail(change, round)
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-a')!.state).toBe('implementing')
      expect(released.length).toBe(0)

      holding.ready = true
      holding.reason = null
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(released.map(row => row.id).join()).toBe('rev1')
      expect(released[0]!.detail).toContain('back with its implementer')
      expect(executions.change(executionId, 'give-a')!.state).toBe('implementing')
    } finally {
      recording.close()
    }
  })

  test('a refused reviewer archive is retried after an executor restart', async () => {
    const { executionId, change, round, released, archive, recording, createExecutor } = await failedReview('give-restart', { spawned: true })
    let restarted: ExecutionExecutor | undefined
    try {
      archive.refused = true
      await fail(change, round)
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-restart')!.state).toBe('implementing')
      expect(released.length).toBeGreaterThan(0)
      expect(bench.records.get('rev1')!.archivedAt).toBeNull()
      recording.close()

      // No release debt lives in the old executor: a new one reads the rows.
      released.length = 0
      archive.refused = false
      restarted = createExecutor()
      await restarted.startup()
      restarted.wake(world.team.teamId)
      await restarted.idle()
      expect(released.map(row => row.id)).toEqual(['rev1'])
      expect(bench.records.get('rev1')!.archivedAt).not.toBeNull()

      restarted.wake(world.team.teamId)
      await restarted.idle()
      expect(released.map(row => row.id)).toEqual(['rev1'])
    } finally {
      recording.close()
      restarted?.close()
    }
  })

  test('a reviewer stays while the change is gating on a passed or open round', async () => {
    const { executionId, change, released, recording } = await failedReview('give-b', { spawned: true })
    try {
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-b')!.state).toBe('gating')
      expect(change.state).toBe('gating')
      expect(released.length).toBe(0)
    } finally {
      recording.close()
    }
  })

  test('a human-created reviewer session is never released', async () => {
    const { executionId, change, round, released, recording } = await failedReview('give-c', { spawned: false })
    try {
      await fail(change, round)
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-c')!.state).toBe('implementing')
      expect(released.length).toBe(0)
    } finally {
      recording.close()
    }
  })

  test('a held change keeps its reviewer until the hold is gone', async () => {
    const { executionId, change, round, released, hold, recording } = await failedReview('give-e', { spawned: true })
    try {
      hold.on = true
      await fail(change, round)
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-e')!.state).toBe('implementing')
      expect(released.length).toBe(0)

      hold.on = false
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(released.map(row => row.id).join()).toBe('rev1')
    } finally {
      recording.close()
    }
  })

  test('an unscoped review group keeps its member', async () => {
    const { executionId, change, round, released, recording } = await failedReview('give-d', { spawned: true }, { scoped: false })
    try {
      await fail(change, round)
      recording.wake(world.team.teamId)
      await recording.idle()
      expect(executions.change(executionId, 'give-d')!.state).toBe('implementing')
      expect(released.length).toBe(0)
    } finally {
      recording.close()
    }
  })
})

describe('the round pipeline (§12)', () => {
  test('a worktree-scoped review group releases the spawned implementer before review (12.4)', async () => {
    const executionId = await approvedExecution('rel-a')
    const staged = await implementStage(executionId, 'rel-a', 'x')
    const worktreeA = staged.row!.worktree!
    // dev is a spawned member working in the change's worktree.
    bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(worktreeA, 'src'), spawned: true })
    const released: string[] = []
    const holding = { ready: true, reason: null as string | null }
    const releasingExecutor = new ExecutionExecutor({
      ...neutralExecutorSeams, plansService: bench.service,
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: { readiness: id => (id === 'dev' ? holding : { ready: true, reason: null }), release: id => { released.push(id); return { ok: true as const } }, pendingSpawns: () => [] },
      groupScoped: () => true,
    })
    try {
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(released).toEqual(['dev'])
      expect(executions.change(executionId, 'rel-a')!.step).toBe('reviewing')

      // A not-ready member holds the step with its reason.
      const execution2 = await approvedExecution('rel-b')
      const second = await implementStage(execution2, 'rel-b', 'x')
      bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: path.join(second.row!.worktree!, 'src'), spawned: true })
      holding.ready = false
      holding.reason = 'busy'
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('releasing')
      // Ready again, the review follows on the next tick.
      holding.ready = true
      ghStub.pulls = '[]'
      passCi()
      releasingExecutor.wake(world.team.teamId)
      await releasingExecutor.idle()
      expect(executions.change(execution2, 'rel-b')!.step).toBe('reviewing')
    } finally {
      releasingExecutor.close()
    }
  })

  test('a spawn still starting in the worktree holds the release step until it can be released', async () => {
    // The instruction's spawn is reserved (team_spawns) but not yet a record:
    // dispatching the review then let the late implementer hold the worktree
    // against the reviewer's spawn (the e2e "review handoff never claimed").
    const executionId = await approvedExecution('rel-s')
    const staged = await implementStage(executionId, 'rel-s', 'x')
    const worktree = staged.row!.worktree!
    const pending: Array<{ groupId: string; worktree: string }> = [
      { groupId: 'reviewers', worktree },
      { groupId: 'dev', worktree: `${worktree}-other` },
      { groupId: 'dev', worktree },
    ]
    const asked: string[] = []
    const released: string[] = []
    const startingExecutor = new ExecutionExecutor({
      ...neutralExecutorSeams, plansService: bench.service,
      store: executions, plans: bench.plans, tasks, assignments, results, mailbox: mail,
      records: () => bench.records.values(),
      teamOf: id => (id === world.team.teamId ? world.team : undefined),
      adapters: { provision: provisionAdapter(executions) },
      roundAdapters: stubRoundAdapters(),
      releases: {
        readiness: () => ({ ready: true, reason: null }),
        release: id => { released.push(id); return { ok: true as const } },
        pendingSpawns: teamId => { asked.push(teamId); return pending },
      },
      groupScoped: () => true,
    })
    try {
      ghStub.pulls = '[]'
      passCi()
      startingExecutor.wake(world.team.teamId)
      await startingExecutor.idle()
      expect(asked).toContain(world.team.teamId)
      const held = executions.change(executionId, 'rel-s')!
      expect(held.step).toBe('releasing')
      expect(held.stopDetail?.message).toContain('dev member is still starting in the worktree')
      expect(executions.rounds(executionId, 'rel-s').at(-1)!.reviewAssignmentId).toBeNull()
      expect(tasks.store.assignmentsOf(held.taskId!).some(row => row.handoffKind === 'review')).toBe(false)

      // The spawn lands as a spawned record in the worktree: it is released, then the review follows.
      pending.splice(2, 1)
      bench.records.set('dev', { ...(bench.records.get('dev') as Exclude<ReturnType<typeof bench.records.get>, undefined>), projectPath: worktree, spawned: true })
      ghStub.pulls = '[]'
      passCi()
      startingExecutor.wake(world.team.teamId)
      await startingExecutor.idle()
      expect(released).toEqual(['dev'])
      expect(executions.change(executionId, 'rel-s')!.step).toBe('reviewing')
    } finally {
      startingExecutor.close()
    }
  })
})
