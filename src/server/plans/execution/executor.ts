// The executor (plan-execution D5): a stored-state loop, single-flight per
// team. `wake(teamId)` schedules one tick; a team never has two at once.
// A tick loads the snapshot, asks the pure `planSteps` for the due
// transitions and effects, applies each transition in its own guarded
// transaction, inserts the effect rows, performs the task-creation and
// dispatch steps, then runs the due effects through the runner — a done
// provision commits its follow-on transition in the same step — and wakes
// again, because a step settled is a step due. While the team has a running
// execution a 60-second timer keeps the loop alive for CI polling, backoffs,
// and timeouts. Everything a tick reads is stored, so a restart resumes
// from the rows alone.
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ChatSessionRecord } from '../../db'
import type { TaskService } from '../../team/TaskService'
import type { TaskResultService } from '../../team/TaskResultService'
import type { AssignmentService } from '../../team/AssignmentService'
import { runGit } from '../../git/gitCommand'
import { logger } from '../../logger'
import { assignmentState } from '../../team/assignmentStore'
import type { MailboxStore } from '../../team/mailboxStore'
import { githubRepoOf } from '../landing/landingProbe'
import { inspectDueUnknownEffects, recoverUnknownEffects } from './executorStartup'
import type { InspectorReads } from './effectInspectors'
import { applyEffectFailure, type OutcomeDeps } from './executorOutcomes'
import { landingAdapters } from './executionLanding'
import { mechanismFor, type LandingMechanism, type LandingMechanisms } from '../landing/landingMechanisms'
import { startupReads } from './startupReads'
import { DIRECT_MECHANISMS } from '../landing/directMechanism'
import type { CiCheck } from '../../../shared/planExecution'
import { ciClass } from '../../../shared/planExecutionGates'
import type { ActiveHold } from '../../../shared/planRevisionControl'
import type { OpenPauseTarget } from '../revisionControl/holdGate'
import type { GhCommandOptions } from '../landing/ghCommand'
import { executionSnapshot } from './executionSnapshot'
import { planSteps } from './executionPlanner'
import { holdGate } from '../revisionControl/holdGate'
import { EffectPinConflict } from './executionEffectStore'
import { ExecutionConflict } from './executionStore'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { dispatchFix, dispatchImplementAttempt, dispatchOwedAttempt, ensureFixAttempt, redispatchStage, type DispatchDeps } from './executionDispatch'
import { StepRefusal } from './stepRefusal'
import { fixRoundOutcome } from '../../../shared/planExecutionProgress'
import { applyRoundStage, releaseFinishedReviewers, type ReleaseSeam, roundAdapters } from './executionRounds'
import { dispatchDeps as dispatchDepsOf, effectRunner, landingDeps as landingDepsOf, outcomeDeps as outcomeDepsOf, roundDeps as roundDepsOf } from './executorDeps'
import { runPauseTick } from '../revisionControl/pauseTick'

/** D5's polling interval while a team has a running execution. */
export const EXECUTOR_TICK_MS = 60_000

export interface ExecutorDeps {
  store: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  assignments: AssignmentService
  /** Review, fix, and update handoffs, and Kawai's acceptance (D7, D11, D13). */
  results: TaskResultService
  /** Every live session record (author profiles for review tags, worktree occupancy). */
  records: () => Iterable<ChatSessionRecord>
  /** The team's mailbox (assignment states derive from instruction mail). */
  mailbox: MailboxStore
  /** D11's release step, wired to member-release by the composition. */
  releases: ReleaseSeam
  /** The plan service, for the system completion when everything landed (D19). */
  plansService: import('../PlanService').PlanService
  /** D13's live condition read: the execution's unresolved acceptance-gated conditions. */
  conditionsOf: (executionId: string) => string[]
  /** Whether a group's current file is worktree-scoped (D11's release step). */
  groupScoped: (teamId: string, groupId: string) => boolean
  /** The team's identity; without it (unknown team) a tick does nothing. */
  teamOf: (teamId: string) => TeamIdentity | undefined
  /** The registered landing mechanisms, by mode (the composition's; direct only by default). */
  mechanisms?: LandingMechanisms
  /** Test seam: the landing adapters (defaults to the real git/gh). */
  landingAdapters?: import('./executionLanding').LandingAdapters
  /** Test seam: effect adapters by kind (the composition passes provision's). */
  adapters?: Partial<Record<string, import('./effects').EffectAdapter>>
  /** Test seam: round-pipeline adapters (push, PRs, CI, rerun); defaults to the real gh/git. */
  roundAdapters?: typeof roundAdapters
  /** The tick interval while a team runs an execution; the development fixture shortens it. */
  tickMs?: number
  /** Test seam: passed to every gh call (a stub gh on a private PATH). */
  ghOptions?: GhCommandOptions
  /** Test seam: the inspectors' reads; defaults to the real git/gh (startupReads). */
  reads?: InspectorReads
  /** Test seam: the clock. */
  now?: () => Date
  /** The promotion runner (integration-candidates D10): its startup, a pass per tick, and whether its timer stays armed. */
  promotions?: { startup(): void; pass(teamId: string): Promise<void>; active(teamId: string): boolean }
  /** The hold gate's reads (revision-control 3.2): the plan's active holds and open pause targets. */
  holds?: { active(teamId: string, planId: string): ActiveHold[]; openTargets(teamId: string, planId: string): OpenPauseTarget[] }
  /** revision-control D7: the checkpoints the tool records and the round results that count as them. */
  checkpoints?: import('../revisionControl/checkpointTool').CheckpointTool
  /** revision-control D8 (4.3): the tick's pause pass — owed mail, Paused recording, closing. */
  pauses?: import('../revisionControl/pauseTick').PauseTickDeps
  /** The owed review-restart stage's dispatch (revision-control 4.5 LC1), wired by the composition from the pause side's stores. */
  reviewRestart?: import('./executionRounds').ReviewRestartSeam
}

export class ExecutionExecutor {
  private readonly ticking = new Set<string>()
  /** Teams woken while their tick ran: exactly one more tick follows (N1). */
  private readonly dirty = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private closed = false

  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Schedule one tick for the team (D5). A wake during a tick marks the team
   * dirty, so exactly one more tick follows the running one; a closed
   * executor refuses. The returned loop never rejects (I2).
   */
  wake(teamId: string): void {
    if (this.closed) return
    if (this.ticking.has(teamId)) {
      this.dirty.add(teamId)
      return
    }
    this.ticking.add(teamId)
    void this.run(teamId)
  }

  /**
   * The team's tick loop. It starts after the waker's synchronous work, so a
   * wake fired inside a caller's transaction never ticks inside it. Every
   * tick failure is logged as `plan_execution_tick_failed` and the timer is
   * still rescheduled: an unhandled rejection would exit the server.
   */
  private async run(teamId: string): Promise<void> {
    await Promise.resolve()
    do {
      this.dirty.delete(teamId)
      try {
        await this.tick(teamId)
      } catch (error) {
        if (!this.closed) logger.error('plan_execution_tick_failed', { teamId, error: String(error) })
      }
    } while (this.dirty.has(teamId) && !this.closed)
    this.ticking.delete(teamId)
    try {
      this.scheduleTimer(teamId)
    } catch (error) {
      if (!this.closed) logger.error('plan_execution_tick_failed', { teamId, error: String(error) })
    }
  }

  /** The in-flight tick, for callers and tests that need to await it. */
  async idle(): Promise<void> {
    while (this.ticking.size > 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  /**
   * Startup recovery (D14): every `running` effect becomes `unknown` and is
   * inspected before anything else for its change runs. Startup never
   * wakes: the runtime wakes the running teams once its wakes are installed.
   */
  async startup(): Promise<void> {
    this.deps.promotions?.startup()
    await recoverUnknownEffects({ store: this.deps.store, ...(this.deps.reads ? { reads: this.deps.reads } : {}), outcomes: this.outcomeDeps(), ...(this.deps.ghOptions ? { ghOptions: this.deps.ghOptions } : {}), ...(this.deps.now ? { now: this.deps.now } : {}) })
  }

  /** Stop the timers (tests, shutdown); a wake's trailing schedule arms none. */
  close(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** One tick: the executions' passes, then the promotions' (D10); exposed for tests, production goes through `wake`. */
  async tick(teamId: string): Promise<void> {
    await this.tickExecutions(teamId)
    if (!this.closed) await this.deps.promotions?.pass(teamId)
  }

  private async tickExecutions(teamId: string): Promise<void> {
    const team = this.deps.teamOf(teamId)
    if (team === undefined) return
    // The pause pass runs before anything plans: a finished execution's open
    // pause still settles here, and the owed mail goes out on the wake the
    // pause command fired (revision-control D8).
    if (this.deps.pauses !== undefined) runPauseTick(this.deps.pauses, teamId, team.groupsRoot)
    // A settled step makes the next due: the tick loops until a pass owes
    // nothing, bounded so a pathological loop cannot spin forever.
    for (let pass = 0; pass < 10; pass++) {
      if (this.closed) return
      const snapshot = executionSnapshot(teamId, team.groupsRoot, this.deps.store, this.deps.plans,
        taskId => this.deps.tasks.store.results.listByTask(taskId)
          .map(result => ({ id: result.id, commit: result.commit, taskRevision: result.taskRevision, submittedBySession: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }))
          .reverse(),
        taskId => this.deps.tasks.store.get(taskId)?.revision ?? 1,
        taskId => this.deps.tasks.store.get(taskId)?.status ?? 'active',
        taskId => {
          // The newest standing assignment is the stage's (a retried stage's
          // failed predecessor stays unsuperseded, older).
          const outstanding = this.deps.tasks.store.assignmentsOf(taskId).filter(row => row.supersededBy === null).at(-1)
          if (outstanding === undefined) return null
          const state = assignmentState(outstanding, outstanding.messageId !== null ? this.deps.mailbox.get(outstanding.messageId) : null)
          return { id: outstanding.id, state: state.state, reason: state.reason, requestKey: outstanding.requestKey ?? null }
        },
        taskId => this.deps.tasks.store.assignmentsOf(taskId).map(row => ({ requestKey: row.requestKey })),
        planId => this.deps.holds?.active(teamId, planId) ?? [],
        planId => this.deps.holds?.openTargets(teamId, planId) ?? [])
      if (snapshot.executions.length === 0) return
      // Not a planned step: it writes no execution state, and a reviewer still
      // busy now is retried by a later tick. A held change keeps its members.
      for (const change of this.deps.store.ownedChanges(teamId)) {
        if (change.state !== 'implementing' || this.gateOf(snapshot, change.executionId)(change.change)) continue
        releaseFinishedReviewers({
          team, executions: this.deps.store, plans: this.deps.plans, records: this.deps.records,
          releases: this.deps.releases, groupScoped: this.deps.groupScoped,
        }, change)
      }
      const steps = planSteps(snapshot, this.deps.now?.().toISOString() ?? new Date().toISOString())
      if (steps.transitions.length === 0 && steps.effects.length === 0 && steps.dispatches.length === 0 && steps.stages.length === 0 && steps.fixes.length === 0) {
        // Nothing new is due, but an effect left pending (a restart, a
        // backoff) still runs — after its inspection answered (D14); one
        // that ran settled a step, so the next pass plans what it made due.
        if (await this.settledRunDue(teamId) === 0) return
        continue
      }

      for (const step of steps.transitions) {
        this.deps.store.transition(step.executionId, step.change, step.guard, step.patch)
      }
      for (const step of steps.effects) {
        try {
          this.deps.store.insertEffect({
            executionId: step.executionId, change: step.change, roundId: null,
            kind: step.kind, effectKey: step.effectKey, command: step.command,
          })
        } catch (error) {
          // A1's backstop: today no planner path can pin-conflict — a re-issue
          // counts past a settled row, and a live row holds the standing
          // check — so the planner re-planning next pass is enough.
          if (!(error instanceof EffectPinConflict)) throw error
          logger.info('plan_execution_effect_pin_conflict', { executionId: step.executionId, kind: step.kind, effectKey: step.effectKey })
        }
      }
      // Each step runs in its own guard: a refused service call stops only
      // its change; any other throw ends the tick (the wake loop logs it).
      for (const step of steps.dispatches) {
        await this.guarded(step, () => step.kind === 'owed'
          ? dispatchOwedAttempt(this.dispatchDeps(team), step)
          : dispatchImplementAttempt(this.dispatchDeps(team), step))
      }
      for (const stage of steps.stages) {
        const row = this.deps.store.change(stage.executionId, stage.change)
        if (row === null) continue
        const gate = this.gateOf(snapshot, stage.executionId)
        await this.guarded(stage, async () => {
          if (stage.kind === 'landing' || stage.kind === 'post-ci') return this.applyLandingStage(team, row, stage, gate)
          if (stage.kind === 'redispatch') return redispatchStage(this.dispatchDeps(team), row)
          if (stage.kind === 'landing-outcome') return this.applyLandingFollowOn(team, row, stage.effectId ?? '', gate)
          return applyRoundStage(this.roundDeps(team, gate), row, stage)
        })
      }
      for (const fix of steps.fixes) {
        await this.guarded(fix, () => this.applyFix(team, fix, this.gateOf(snapshot, fix.executionId)))
      }
      // A done effect's follow-on transition lands with its outcome (D14),
      // so the next pass sees the state it implies — and an effect the
      // restart left due runs even when the planner owes no new step.
      await this.settledRunDue(teamId)
    }
  }

  private roundDeps(team: TeamIdentity, gate?: (change: string) => boolean): import('./executionRounds').RoundDeps {
    return roundDepsOf(this.deps, team, this.repoOf(team), gate)
  }

  /**
   * The hold gate over one execution (revision-control 3.2), built from the
   * tick's snapshot — planning-time, so a hold placed mid-tick is seen on
   * the next one. Unknown executions gate nothing.
   */
  private gateOf(snapshot: import('./executionSnapshot').ExecutionSnapshot, executionId: string): (change: string) => boolean {
    const execution = snapshot.executions.find(row => row.row.id === executionId)
    if (execution === undefined) return () => false
    return change => holdGate(execution.holds, execution.openTargets, change) !== null
  }

  /** origin as owner/repo, read once from the main checkout's remote (the probe's fact). */
  private repoCache = new Map<string, string>()
  private repoOf(team: TeamIdentity): string {
    const cached = this.repoCache.get(team.teamId)
    if (cached !== undefined) return cached
    const remote = runGit(['config', '--get', 'remote.origin.url'], { cwd: team.groupsRoot })
    const repo = remote.ok ? githubRepoOf(remote.stdout) ?? '' : ''
    this.repoCache.set(team.teamId, repo)
    return repo
  }

  /**
   * runDue, with a tick abandoned by `close` swallowing its late writes; the
   * count of effects run. The due `unknown` effects are inspected first
   * (D14) — a restart's rows and a Retry's reset after an `effect-unknown`
   * stop are never run again before an inspection answered them.
   */
  private async settledRunDue(teamId: string): Promise<number> {
    if (this.closed) return 0
    try {
      await inspectDueUnknownEffects({
        store: this.deps.store, reads: this.deps.reads ?? startupReads(this.deps.ghOptions),
        outcomes: this.outcomeDeps(), teamId, ...(this.deps.now ? { now: this.deps.now } : {}),
      })
      return await this.runner().runDue(teamId)
    } catch (error) {
      // A test or shutdown closed the database under an in-flight effect:
      // the tick is abandoned, not failed — the next executor resumes.
      if (!this.closed) throw error
      return 0
    }
  }

  private runner(): import('./effects').EffectRunner {
    return effectRunner(this.deps, executionId => this.mechanismOf(executionId))
  }

  /**
   * A settled merge or update-branch effect's follow-on (D13). A change the
   * Retry left waiting for the slot (A2's fallback) re-enters landing at its
   * effect's step first, so the verdict's landing guards see the stage — the
   * slot taken meanwhile leaves it waiting for the next tick. A stopped
   * execution's merge that did not complete leaves the change cancelled,
   * with Kawai's task, in one transaction (D12).
   */
  private async applyLandingFollowOn(team: TeamIdentity, row: import('./executionRows').ChangeRow, effectId: string, gate?: (change: string) => boolean): Promise<void> {
    const effect = this.deps.store.effectsOf(row.executionId).find(entry => entry.id === effectId)
    if (effect === undefined) return
    const waiting = this.deps.store.change(row.executionId, row.change)
    if (waiting !== null && waiting.state === 'gating' && waiting.step === 'awaiting-slot'
      && (effect.state === 'done' || (effect.state === 'failed' && (effect.outcome as { stop?: unknown } | null)?.stop !== undefined))) {
      try {
        this.deps.store.transition(row.executionId, row.change, waiting, {
          state: 'landing', step: effect.kind === 'update-branch' ? 'updating' : 'merging',
        })
      } catch (error) {
        if (!(error instanceof ExecutionConflict) || error.kind !== 'slot-taken') throw error
        return
      }
    }
    if (effect.state === 'done') await this.mechanismOf(row.executionId).landOutcome(this.landingDeps(team, gate), effect, this.deps.landingAdapters ?? landingAdapters)
    else if (effect.state === 'failed' && (effect.outcome as { stop?: unknown } | null)?.stop !== undefined) {
      // An inspection's stop verdict for a resumed change (pr-closed, a
      // foreign branch): the same stop a run's failure would have written.
      applyEffectFailure(this.outcomeDeps(), effect)
    }
    const execution = this.deps.store.execution(row.executionId)
    const fresh = this.deps.store.change(row.executionId, row.change)
    if (execution === null || execution.state === 'running' || fresh === null || fresh.state !== 'landing') return
    const task = fresh.taskId === null ? null : this.deps.tasks.store.get(fresh.taskId) ?? null
    const prepared = task !== null && task.status !== 'done' && task.status !== 'cancelled'
      ? await this.deps.tasks.prepareStatus({ kind: 'system', team, origin: { kind: 'execution', executionId: row.executionId } }, task.id, 'cancelled', 'Execution stopped; its merge did not complete.')
      : null
    this.deps.store.atomically(() => {
      const current = this.deps.store.change(row.executionId, row.change)
      if (current === null || current.state !== 'landing') return
      this.deps.store.transition(row.executionId, row.change, current, { state: 'cancelled', step: null })
      prepared?.commit()
    })
  }

  /** The execution's landing mechanism, by its recorded mode (integration-candidates D1). */
  private mechanismOf(executionId: string): LandingMechanism {
    return mechanismFor(this.deps.mechanisms ?? DIRECT_MECHANISMS, this.deps.store.execution(executionId)?.landingMode ?? 'direct')
  }

  private landingDeps(team: TeamIdentity, gate?: (change: string) => boolean): import('./executionLanding').LandingDeps {
    return landingDepsOf(this.deps, team, this.repoOf(team), () => this.roundDeps(team, gate), gate)
  }

  /** The landing stages (D13): a passed change lands; a landed change's base CI lands as evidence. */
  private async applyLandingStage(team: import('../../team/teamIdentity').TeamIdentity, row: import('./executionRows').ChangeRow, stage: { kind: string; roundId: string | null }, gate?: (change: string) => boolean): Promise<void> {
    if (stage.kind === 'landing' && stage.roundId !== null) {
      const round = this.deps.store.round(stage.roundId)
      if (row.branch === null || round === null) return
      await this.mechanismOf(row.executionId).land(this.landingDeps(team, gate), this.deps.landingAdapters ?? landingAdapters, row, round)
      return
    }
    if (stage.kind === 'post-ci') {
      // D13 step 6: base-branch CI on the merge commit, polled until done.
      const execution = this.deps.store.execution(row.executionId)
      const fact = execution === null ? null : this.deps.store.landings(execution.planId).find(entry => entry.change === row.change)
      if (execution === null || fact === null || fact === undefined) return
      // Through the round adapters, like every other CI read: the fixture
      // and test adapters answer it too.
      const adapters = this.deps.roundAdapters ?? roundAdapters
      const runs = await adapters.checkRuns(this.repoOf(team), fact.mergeSha, this.deps.ghOptions)
      const statuses = await adapters.statuses(this.repoOf(team), fact.mergeSha, this.deps.ghOptions)
      if (!runs.ok || !statuses.ok) return
      const checks: CiCheck[] = [...runs.data, ...statuses.data]
      const pending = checks.some(check => ciClass(check) === 'pending')
      if (!pending) this.deps.store.setLandingPostCi(execution.planId, row.change, checks)
    }
  }

  /**
   * D12's fix step: the count rule decides — three consecutive failed fix
   * rounds stop the change, anything else returns it to implementing and
   * dispatches the fix attempt naming the failing checks, findings, count,
   * and the commit to continue from.
   */
  private async applyFix(team: import('../../team/teamIdentity').TeamIdentity, fix: { executionId: string; change: string; roundId: string }, gate?: (change: string) => boolean): Promise<void> {
    const store = this.deps.store
    const round = store.round(fix.roundId)
    const row = store.change(fix.executionId, fix.change)
    // A carried round that failed base-merge CI fixes from `landing`, leaving the slot.
    if (round === null || row === null || (row.state !== 'gating' && row.state !== 'landing')) return
    this.mechanismOf(fix.executionId).roundFailed?.(round)
    const outcome = fixRoundOutcome(row.fixRounds, { fixRound: round.fixRound, outcome: 'fail' })
    if (outcome.stop) {
      store.transition(fix.executionId, fix.change, row, {
        state: 'stopped', stopReason: 'round-limit', step: null,
        stopDetail: { message: `Three consecutive failed fix rounds.`, checks: (round.ci ?? []).filter(check => check.conclusion === 'failure').map(check => check.name) },
      })
      return
    }
    const revision = this.deps.plans.revision(store.execution(fix.executionId)!.planId, store.execution(fix.executionId)!.revision)
    const group = revision?.content.changes.find(entry => entry.change === fix.change)?.group
    if (group === null || group === undefined) return
    const failing = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'failure')
      .map(check => ({ name: check.name, conclusion: check.conclusion, link: check.link }))
    const all = row.taskId === null ? [] : this.deps.tasks.store.results.findingsFor(round.resultId)
    const findings = round.verdictFindingsId !== null ? all.filter(entry => entry.id === round.verdictFindingsId) : all
    // The dispatch comes first: a refused fix stops the change while it is
    // still gating on the failed round, so Retry finds the round again. The
    // dispatch replays under its key if the transition below never landed.
    // Under a hold (revision-control 3.2) the attempt row — the owed
    // dispatch's marker — is still created and the fix transition stands;
    // only the handoff waits, and the release dispatches it once. This is
    // the change's one writer for its own row (H″ O2): a refused send wrote
    // nothing, and the fixes step re-sends the same key after Retry; the
    // owed step never fires here — 'gating' is not a fix row's owed state.
    const input = {
      executionId: fix.executionId, change: fix.change, group,
      failingChecks: failing,
      findingsIds: findings.map(entry => entry.id),
      findingsTexts: findings.map(entry => entry.findings),
      continueFrom: round.commitSha,
      fixRounds: outcome.count,
    }
    const attempt = await ensureFixAttempt(this.dispatchDeps(team), input)
    if (attempt !== null && gate?.(fix.change) !== true) await dispatchFix(this.dispatchDeps(team), input, attempt)
    store.transition(fix.executionId, fix.change, row, { state: 'implementing', step: null, fixRounds: outcome.count })
  }

  private dispatchDeps(team: TeamIdentity): DispatchDeps {
    return dispatchDepsOf(this.deps, team)
  }

  /** Run one step; a StepRefusal stops its change as instruction-failed, anything else propagates. */
  private async guarded(target: { executionId: string; change: string }, step: () => Promise<void>): Promise<void> {
    try {
      await step()
    } catch (error) {
      if (!(error instanceof StepRefusal)) throw error
      this.stopRefused(target, error)
    }
  }

  /**
   * A refused step (I2, D12): the change stops as `instruction-failed` with
   * the stage, the refusal text, and the state it was in, which Retry
   * resumes so the stage dispatches again.
   */
  private stopRefused(target: { executionId: string; change: string }, refusal: StepRefusal): void {
    logger.warn('plan_execution_step_refused', { executionId: target.executionId, change: target.change, stage: refusal.stage, refusal: refusal.refusal })
    const row = this.deps.store.change(target.executionId, target.change)
    if (row === null || row.state === 'stopped' || row.state === 'cancelled' || row.state === 'landed') return
    this.deps.store.transition(target.executionId, target.change, row, {
      state: 'stopped', stopReason: 'instruction-failed', step: null,
      stopDetail: { message: refusal.message, stage: refusal.stage, refusal: refusal.refusal, resumeState: row.state },
    })
  }

  private outcomeDeps(): OutcomeDeps {
    return outcomeDepsOf(this.deps, executionId => this.mechanismOf(executionId))
  }

  /** While the team runs an execution or a promotion, the 60-second timer keeps the loop alive (D5). */
  private scheduleTimer(teamId: string): void {
    if (this.closed) return
    clearTimeout(this.timers.get(teamId))
    this.timers.delete(teamId)
    if (this.deps.store.runningForTeam(teamId).length === 0 && this.deps.promotions?.active(teamId) !== true) return
    this.timers.set(teamId, setTimeout(() => {
      this.timers.delete(teamId)
      this.wake(teamId)
    }, this.deps.tickMs ?? EXECUTOR_TICK_MS))
  }
}
