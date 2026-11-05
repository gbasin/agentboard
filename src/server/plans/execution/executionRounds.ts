// The round pipeline (plan-execution D9-D11, §12): a newer result becomes
// the change's round (superseding the open one, unless its merge started),
// the round's commit is pushed and given the change's one pull request, CI
// is read and evaluated with the one rerun, a passing round releases the
// worktree's spawned implementer and dispatches the review handoff, and the
// verdict — only an independent claimant's, never an author's — decides the
// round. Effects are recorded before they run (D14); the CI read runs in
// the tick (one read per gating round per minute, driven by the timer).
import path from 'node:path'
import type { TeamIdentity } from '../../team/teamIdentity'
import type { ChatSessionRecord } from '../../db'
import type { TaskService } from '../../team/TaskService'
import type { TaskResultService } from '../../team/TaskResultService'
import { effectiveExtraChecks, evaluateCi, reviewVerdict, splitExtraChecks } from '../../../shared/planExecutionGates'
import type { CiCheck, StopDetail, StopReason } from '../../../shared/planExecution'
import type { PlanCheck } from '../../../shared/plans'
import type { RoundRow } from './executionRows'
import type { ExecutionStore } from './executionStore'
import type { PlanStore } from '../planStore'
import { lsRemoteHead, pushToRemote } from '../landing/gitRemote'
import { ghCheckRuns, ghPrCreate, ghPrList, ghRerunFailed, ghStatuses } from '../landing/github'
import type { GhCommandOptions } from '../landing/ghCommand'
import type { AssignmentService } from '../../team/AssignmentService'
import { dispatchFix, ensureFixAttempt } from './executionDispatch'
import { refusable } from './stepRefusal'
import type { EffectAdapter } from './effects'

/** The gh/git surface the pipeline uses; injectable for tests. */
export interface RoundAdapters {
  lsRemoteHead: typeof lsRemoteHead
  push: typeof pushToRemote
  checkRuns: typeof ghCheckRuns
  statuses: typeof ghStatuses
  prList: typeof ghPrList
  prCreate: typeof ghPrCreate
  rerun: typeof ghRerunFailed
}

export const roundAdapters: RoundAdapters = {
  lsRemoteHead, push: pushToRemote, checkRuns: ghCheckRuns, statuses: ghStatuses,
  prList: ghPrList, prCreate: ghPrCreate, rerun: ghRerunFailed,
}

/**
 * Member release's readiness and release (D11). `release` reports whether
 * the archive happened; a refused one holds the step at `releasing`.
 */
export interface ReleaseSeam {
  readiness: (sessionId: string) => { ready: boolean; reason: string | null }
  /** `detail` finishes the release's journal line; without it the line names the review handoff. */
  release: (sessionId: string, detail?: string) => { ok: true } | { ok: false; error: string }
  /** The team's in-flight spawn reservations (staffing's `team_spawns`), each with its worktree root. */
  pendingSpawns: (teamId: string) => Array<{ groupId: string; worktree: string }>
}

export interface RoundDeps {
  team: TeamIdentity
  /** origin as owner/repo (the probe's read); every gh call is addressed to it. */
  repo: string
  executions: ExecutionStore
  plans: PlanStore
  tasks: TaskService
  results: TaskResultService
  assignments: AssignmentService
  adapters: RoundAdapters
  /** Passed to every gh call (tests stub gh on a private PATH). */
  ghOptions?: GhCommandOptions
  /** D11's release step: readiness and the archive+journal release of one spawned member. */
  releases: ReleaseSeam
  /** The group files: whether the review group is worktree-scoped. */
  groupScoped: (teamId: string, groupId: string) => boolean
  records: () => Iterable<ChatSessionRecord>
  now: () => string
  /** The hold gate (revision-control 3.2): true when the change is held. */
  gate?: (change: string) => boolean
  /** The owed review-restart stage's dispatch (revision-control 4.5 LC1), wired by the composition from the pause side's stores. */
  reviewRestart?: ReviewRestartSeam
}

/**
 * The owed review-restart stage's seam (LC1): dispatches the change's one
 * owed review handoff — the fresh `…:restart` key, the recorded notes — and
 * returns the assignment id; `null` (no standing restart decision, or the
 * change's facts missing) leaves the stage due.
 */
export type ReviewRestartSeam = (input: {
  team: TeamIdentity
  changeRow: { executionId: string; change: string; taskId: string }
  round: RoundRow
  tags?: string[]
}) => Promise<string | null>

/** One stage performance; throws nothing — a failed git/gh read leaves the stage due again. */
export async function applyRoundStage(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null; taskId: string | null }, stage: { kind: string; roundId: string | null; resultId: string | null }): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)
  if (execution === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change) ?? null

  if (stage.kind === 'result' && stage.resultId !== null) {
    const attempt = store.attempts(changeRow.executionId, changeRow.change).at(-1)
    if (attempt === undefined) return
    const commit = deps.tasks.store.results.get(stage.resultId)?.commit
    if (commit === null || commit === undefined) return
    // A7: the superseded round's live push, PR, and rerun rows are
    // cancelled — they never run after the newer result nor decide anything.
    const prior = store.rounds(changeRow.executionId, changeRow.change).at(-1) ?? null
    store.insertRound({
      executionId: changeRow.executionId, change: changeRow.change,
      attemptId: attempt.id, resultId: stage.resultId, commitSha: commit,
      fixRound: attempt.kind !== 'implement',
    })
    if (prior !== null && prior.outcome === null) store.cancelLiveRoundEffects(changeRow.executionId, prior.id)
    return
  }

  const round = stage.roundId === null ? null : store.round(stage.roundId)
  if (round === null) return

  // Push and open-pr are effect rows (D14): the runner calls them, and the
  // done handler records what they imply. The stage only inserts the row.
  if (stage.kind === 'push') {
    const change = store.change(changeRow.executionId, changeRow.change)
    if (change === null) return
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'push',
      effectKey: `${changeRow.executionId}:${changeRow.change}:push:${round.number}:${change.generation}`,
      command: { cwd: changeRow.worktree ?? deps.team.groupsRoot, commit: round.commitSha, branch: changeRow.branch ?? changeRow.change },
    })
    return
  }

  if (stage.kind === 'open-pr') {
    if (changeRow.branch === null) return
    const change = store.change(changeRow.executionId, changeRow.change)
    if (change === null) return
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'open-pr',
      effectKey: `${changeRow.executionId}:${changeRow.change}:open-pr:${round.number}:${change.generation}`,
      command: { repo: deps.repo, head: changeRow.branch, base: execution.baseBranch, title: `${changeRow.change} — ${deps.plans.get(execution.planId)?.title ?? execution.planId} (r${execution.revision})` },
    })
    return
  }

  if (stage.kind === 'ci') return pollCi(deps, changeRow, round, effectiveExtraChecks(revision?.content, entry))
  if (stage.kind === 'review') return dispatchReview(deps, changeRow, round)
  if (stage.kind === 'review-restart') return dispatchRestartedReview(deps, changeRow, round)
  if (stage.kind === 'verdict') return decideVerdict(deps, changeRow, round, effectiveExtraChecks(revision?.content, entry))
  if (stage.kind === 'revision') {
    await dispatchRevisionAttempt(deps, changeRow, round)
    return
  }
}

/** D9: the round's result is pinned to a task revision older than the task's current one. */
export function revisionPending(deps: Pick<RoundDeps, 'tasks'>, taskId: string | null, round: RoundRow): boolean {
  const task = taskId === null ? null : deps.tasks.store.get(taskId)
  if (task === null || task === undefined) return false
  const result = deps.tasks.store.results.get(round.resultId)
  return result !== null && result !== undefined && result.taskRevision < task.revision
}

/**
 * D9's fix attempt naming a newer task revision: supersede the pinned round
 * and return the change to implementing — leaving `landing` releases the
 * slot. A revision applied once a failed branch update settled (D9, D13)
 * names the base head and the conflicting files too, so one attempt answers
 * both and no update attempt follows. False when no revision is pending.
 */
export async function dispatchRevisionAttempt(deps: RoundDeps, changeRow: { executionId: string; change: string; taskId: string | null }, round: RoundRow, update?: { base: string; files: string[] }): Promise<boolean> {
  const store = deps.executions
  if (!revisionPending(deps, changeRow.taskId, round)) return false
  const task = deps.tasks.store.get(changeRow.taskId!)!
  const change = store.change(changeRow.executionId, changeRow.change)
  const execution = store.execution(changeRow.executionId)
  if (change === null || execution === null) return false
  store.supersedeRound(round.id)
  // A7: the superseded round's live round-effect rows never run after it.
  store.cancelLiveRoundEffects(changeRow.executionId, round.id)
  store.transition(changeRow.executionId, changeRow.change, change, { state: 'implementing', step: null })
  const group = deps.plans.revision(execution.planId, execution.revision)?.content.changes.find(entry => entry.change === changeRow.change)?.group
  if (group === null || group === undefined) return true
  const revisionRow = deps.tasks.store.revisions(task.id).at(-1)
  const texts = [`The task's direction was republished as revision ${task.revision}${revisionRow?.rationale ? ` (${revisionRow.rationale})` : ''}. Re-apply your work on top of the new direction.`]
  if (update !== undefined) {
    texts.push(`GitHub's update of the branch with the base did not merge cleanly (base head ${update.base}${update.files.length > 0 ? `; conflicting files: ${update.files.join(', ')}` : ''}). Merge the base branch as part of this attempt.`)
  }
  // The attempt row — the owed dispatch's marker (revision-control 3.2) —
  // is created however the gate reads; the handoff only when unheld, and
  // the release dispatches it once through dispatchOwedAttempt.
  const attempt = await ensureFixAttempt(
    { team: deps.team, executions: store, plans: deps.plans, tasks: deps.tasks, assignments: deps.assignments, results: deps.results },
    {
      executionId: changeRow.executionId, change: changeRow.change, group,
      failingChecks: [], findingsIds: [], findingsTexts: texts,
      continueFrom: round.commitSha, fixRounds: change.fixRounds,
    },
  )
  if (attempt === null || deps.gate?.(changeRow.change) === true) return true
  await dispatchFix(
    { team: deps.team, executions: store, plans: deps.plans, tasks: deps.tasks, assignments: deps.assignments, results: deps.results },
    {
      executionId: changeRow.executionId, change: changeRow.change, group,
      failingChecks: [], findingsIds: [], findingsTexts: texts,
      continueFrom: round.commitSha, fixRounds: change.fixRounds,
    },
    attempt,
  )
  return true
}

async function pollCi(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow, extra: PlanCheck[]): Promise<void> {
  const store = deps.executions
  const execution = store.execution(changeRow.executionId)!
  const repo = deps.repo
  const runs = await deps.adapters.checkRuns(repo, round.commitSha, deps.ghOptions)
  const statuses = await deps.adapters.statuses(repo, round.commitSha, deps.ghOptions)
  if (!runs.ok || !statuses.ok) return
  const checks: CiCheck[] = [...runs.data, ...statuses.data]
  // The round's one rerun (D10), whatever generation requested it: a later
  // transition never earns the round a second one. One still settling waits.
  const rerunEffect = store.effectsOf(changeRow.executionId)
    .filter(effect => effect.roundId === round.id && effect.kind === 'rerun' && effect.state !== 'cancelled').at(-1) ?? null
  if (rerunEffect !== null && rerunEffect.state !== 'done' && rerunEffect.state !== 'failed') return
  const rerunOutcome = rerunEffect !== null && rerunEffect.state === 'done' && rerunEffect.outcome !== null && typeof rerunEffect.outcome === 'object'
    ? rerunEffect.outcome as { at?: string; runIds?: number[] } : null
  const evaluation = evaluateCi(checks, execution.floor.map, {
    windowFrom: round.ciWindowFrom ?? round.pushedAt ?? deps.now(), now: deps.now(),
    rerun: rerunOutcome?.at && Array.isArray(rerunOutcome.runIds) ? { at: rerunOutcome.at, runIds: rerunOutcome.runIds } : null,
  })
  store.setRoundCi(round.id, checks, rerunOutcome?.at ?? null)
  if (evaluation.kind === 'pending') return
  if (evaluation.kind === 'pass') {
    // A carried round keeps its source's review, so its verdict decides now
    // (D13); otherwise the review stage follows in the same tick: release,
    // then handoff (D11).
    if (round.carriedFrom !== null) return decideVerdict(deps, changeRow, store.round(round.id)!, extra)
    return dispatchReview(deps, changeRow, store.round(round.id)!)
  }
  if (evaluation.kind === 'fail') {
    store.decideRound(round.id, 'fail')
    return
  }
  if (evaluation.kind === 'rerun') {
    // The round's one rerun: an effect row, retried and inspected like any (D14).
    const change = store.change(changeRow.executionId, changeRow.change)!
    store.insertEffect({
      executionId: changeRow.executionId, change: changeRow.change, roundId: round.id, kind: 'rerun',
      effectKey: `${changeRow.executionId}:${changeRow.change}:rerun:${round.number}:${change.generation}`,
      command: { repo: deps.repo, runIds: evaluation.runIds },
    })
    return
  }
  return stopChange(deps, changeRow, evaluation.reason, evaluation.detail)
}

async function dispatchReview(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow): Promise<void> {
  const store = deps.executions
  // A held change hands off no review (revision-control 3.2): neither the
  // implementer's release below nor the handoff runs. The release re-fires
  // the stage from CI — the round's review assignment stays null, so the
  // next pass re-plans the ci stage and lands here again.
  if (deps.gate?.(changeRow.change) === true) return
  const execution = store.execution(changeRow.executionId)!
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change) ?? null
  const reviewGroup = entry?.reviewGroup ?? revision?.content.reviewGroup ?? null
  if (reviewGroup === null) return
  let change = store.change(changeRow.executionId, changeRow.change)!
  // D11 step 1 — Release: a worktree-scoped review group gets the worktree,
  // so each live spawned member in it is released once ready; a not-ready
  // member, or a release that is refused, holds the step at `releasing`
  // with the reason in the detail, and no review is dispatched — the next
  // wake re-checks. Human-created sessions never release. An unscoped group
  // skips the step and leaves the implementer working.
  if (change.worktree !== null && deps.groupScoped(deps.team.teamId, reviewGroup)) {
    const worktree = change.worktree
    const inWorktree = (dir: string) => dir === worktree || dir.startsWith(`${worktree}${path.sep}`)
    // A spawn still starting in the worktree (the instruction's reservation)
    // is a member the records do not list yet: dispatching now would let it
    // arrive after the review and hold the worktree against the reviewer, so
    // the step waits until it is a record that can be released.
    const starting = deps.releases.pendingSpawns(deps.team.teamId)
      .find(spawn => spawn.groupId !== reviewGroup && inWorktree(spawn.worktree))
    if (starting !== undefined) {
      const held = store.change(changeRow.executionId, changeRow.change)!
      const message = `A ${starting.groupId} member is still starting in the worktree; it is released before the review`
      if (held.step !== 'releasing' || held.stopDetail?.message !== message) {
        store.transition(changeRow.executionId, changeRow.change, held, { step: 'releasing', stopDetail: { message } })
      }
      return
    }
    const members = [...deps.records()].filter(record =>
      record.archivedAt == null && record.spawned === true && inWorktree(record.projectPath)
      && record.groupId !== reviewGroup)
    for (const member of members) {
      const readiness = deps.releases.readiness(member.sessionId)
      const released = readiness.ready ? deps.releases.release(member.sessionId) : { ok: false as const, error: readiness.reason ?? 'not ready' }
      if (!released.ok) {
        const held = store.change(changeRow.executionId, changeRow.change)!
        const message = `Waiting to release ${member.sessionId} before the review: ${released.error}`
        if (held.step !== 'releasing' || held.stopDetail?.message !== message) {
          store.transition(changeRow.executionId, changeRow.change, held, { step: 'releasing', stopDetail: { message, session: member.sessionId } })
        }
        return
      }
    }
  }
  change = store.change(changeRow.executionId, changeRow.change)!
  if (change.step !== 'reviewing') store.transition(changeRow.executionId, changeRow.change, change, { step: 'reviewing', stopDetail: null })
  const role = revision?.content.roles.find(candidate => candidate.group === reviewGroup)?.profiles ?? []
  const authors = (change.taskId ? deps.tasks.store.results.listByTask(change.taskId) : [])
    .map(result => result.submittedBy.sessionId).filter((id): id is string => id !== null)
  const outcome = await refusable('review', () => deps.results.handoff({ kind: 'system', team: deps.team, origin: { kind: 'execution', executionId: changeRow.executionId } }, change.taskId!, {
    kind: 'review', resultId: round.resultId, target: { kind: 'group', id: reviewGroup },
    instructions: reviewInstruction(deps, changeRow.change, round, effectiveExtraChecks(revision?.content, entry), [...entry?.acceptance ?? [], ...revision?.content.acceptanceRules ?? []]),
    requestKey: `exec:${changeRow.executionId}:${changeRow.change}:round:${round.number}:review:${change.generation}`,
    ...(role.length > 0 ? { allowedProfiles: role } : {}),
    tags: authorProfileTags(profilesOfRecords(deps), authors),
  }))
  store.setRoundReview(round.id, outcome.assignment.id)
}

/**
 * D11's other direction: a change back with its implementer needs the
 * worktree the review had, and one member per worktree means a finished
 * reviewer left live keeps the implementer's mail queued. Each tick releases
 * the review group's ready spawned members in the worktree; one still busy
 * waits for a later tick. Human-created sessions and unscoped groups are left
 * alone, as in the release before the review.
 */
export function releaseFinishedReviewers(
  deps: Pick<RoundDeps, 'team' | 'executions' | 'plans' | 'records' | 'releases' | 'groupScoped'>,
  changeRow: { executionId: string; change: string; worktree: string | null },
): void {
  const worktree = changeRow.worktree
  if (worktree === null) return
  const execution = deps.executions.execution(changeRow.executionId)
  if (execution === null) return
  const revision = deps.plans.revision(execution.planId, execution.revision)
  const entry = revision?.content.changes.find(candidate => candidate.change === changeRow.change) ?? null
  const reviewGroup = entry?.reviewGroup ?? revision?.content.reviewGroup ?? null
  if (reviewGroup === null || reviewGroup === entry?.group || !deps.groupScoped(deps.team.teamId, reviewGroup)) return
  // A snapshot: a release archives the member it names.
  const members = [...deps.records()].filter(member =>
    member.archivedAt == null && member.spawned === true && member.groupId === reviewGroup
    && (member.projectPath === worktree || member.projectPath.startsWith(`${worktree}${path.sep}`)))
  for (const member of members) {
    if (deps.releases.readiness(member.sessionId).ready) {
      deps.releases.release(member.sessionId, ' after its review: the change is back with its implementer (plan-execution D11)')
    }
  }
}

/** The result authors' profile tags, deduped — a review handoff routes away from the author's model (D5's tag grammar). */
export function authorProfileTags(profilesOf: (sessionId: string) => string | null, sessionIds: string[]): string[] {
  return [...new Set(sessionIds.map(session => profilesOf(session)).filter((profile): profile is string => profile !== null)
    .map(profile => `author-profile:${profile}`))]
}

function profilesOfRecords(deps: RoundDeps): (sessionId: string) => string | null {
  return sessionId => {
    const record = [...deps.records()].find(row => row.sessionId === sessionId)
    return record?.claudeProfileId ?? null
  }
}

/**
 * The owed review-restart stage (LC1): the held restart dropped the round's
 * stale pointer and marked this step, so nothing waits on the superseded
 * handoff. The seam dispatches the one owed handoff — the fresh `…:restart`
 * key and the recorded notes — and the change returns to `reviewing`. A
 * seam-less composition, a missing change task, or a null return leaves the
 * stage due; the keyed dispatch replays a crash between the send and the
 * pointer write.
 */
async function dispatchRestartedReview(deps: RoundDeps, changeRow: { executionId: string; change: string; taskId: string | null }, round: RoundRow): Promise<void> {
  if (deps.reviewRestart === undefined || changeRow.taskId === null) return
  // The restarted handoff routes like a fresh review (LC3): the result
  // authors' profile tags ride it.
  const authors = deps.tasks.store.results.listByTask(changeRow.taskId)
    .map(result => result.submittedBy.sessionId).filter((id): id is string => id !== null)
  const assignmentId = await deps.reviewRestart({
    team: deps.team,
    changeRow: { executionId: changeRow.executionId, change: changeRow.change, taskId: changeRow.taskId },
    round,
    tags: authorProfileTags(profilesOfRecords(deps), authors),
  })
  if (assignmentId === null) return
  deps.executions.setRoundReview(round.id, assignmentId)
  const change = deps.executions.change(changeRow.executionId, changeRow.change)
  if (change !== null && change.step === 'review-restart') {
    deps.executions.transition(changeRow.executionId, changeRow.change, change, { step: 'reviewing' })
  }
}

async function decideVerdict(deps: RoundDeps, changeRow: { executionId: string; change: string; branch: string | null; worktree: string | null }, round: RoundRow, extra: PlanCheck[]): Promise<void> {
  const store = deps.executions
  const change = store.change(changeRow.executionId, changeRow.change)
  if (change === null || change.taskId === null) return
  const assignment = deps.tasks.store.assignmentsOf(change.taskId).find(row => row.id === round.reviewAssignmentId)
  const claimants = assignment?.claimedBy ? [assignment.claimedBy] : []
  const authors = deps.tasks.store.results.listByTask(change.taskId)
    .map(result => result.submittedBy.sessionId).filter((id): id is string => id !== null)
  const findings = deps.tasks.store.results.findingsFor(round.resultId)
    .map(row => ({ id: row.id, resultId: row.resultId, handoffId: row.handoffId, author: row.author.kind === 'agent' ? row.author.sessionId! : '', verdict: row.verdict, createdAt: row.createdAt }))
  const verdict = reviewVerdict(round, findings, claimants, authors)
  if (verdict.kind === 'pending') return
  if (verdict.kind === 'author-claimant') {
    return stopChange(deps, changeRow, 'review-unavailable', { message: `Session ${verdict.session} claimed the review of its own work.`, session: verdict.session })
  }
  const counted = verdict.kind === 'pass' ? verdict.findingsId : verdict.kind === 'fail' ? verdict.findingsId : null
  if (verdict.kind === 'fail') {
    store.decideRound(round.id, 'fail', { verdictFindingsId: counted ?? undefined })
    return
  }
  // Pass: the extra checks CI decides must be green; the attested ones ride
  // the verdict (D11).
  const reported = new Set((round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'success').map(check => check.name))
  const split = splitExtraChecks(extra, [...reported])
  const extraView = [
    ...split.ci.map(check => ({ name: check.name, description: check.description, command: check.command ?? null, by: 'ci' as const, outcome: 'success' })),
    ...split.attested.map(check => ({ name: check.name, description: check.description, command: check.command ?? null, by: 'reviewer' as const, outcome: 'attested' })),
  ]
  store.decideRound(round.id, 'pass', { verdictFindingsId: counted ?? undefined, extra: extraView })
  const fresh = store.change(changeRow.executionId, changeRow.change)!
  // A pass resets the consecutive failed fix rounds (D12's count).
  store.transition(changeRow.executionId, changeRow.change, fresh, { passedAt: deps.now(), step: null, fixRounds: 0 })
}

/** Record the change's pull request (the open-pr effect's done handler). */
export function recordPull(executions: ExecutionStore, executionId: string, change: string, pr: { number: number; url: string; openedByKawai: boolean }): void {
  const row = executions.change(executionId, change)
  if (row === null) return
  // A reused pull request keeps who opened it: re-listing Kawai's own PR in
  // a later round finds it open, which never makes it someone else's.
  const openedByKawai = pr.openedByKawai || (row.prNumber === pr.number && row.prOpenedByKawai)
  // An unchanged PR writes nothing: the transition would bump the change's generation.
  if (row.prNumber === pr.number && row.prUrl === pr.url && row.prOpenedByKawai === openedByKawai) return
  executions.transition(executionId, change, row, { prNumber: pr.number, prUrl: pr.url, prOpenedByKawai: openedByKawai })
}

async function stopChange(deps: RoundDeps, changeRow: { executionId: string; change: string }, reason: StopReason, detail: StopDetail): Promise<void> {
  const change = deps.executions.change(changeRow.executionId, changeRow.change)
  if (change === null) return
  deps.executions.transition(changeRow.executionId, changeRow.change, change, { state: 'stopped', stopReason: reason as StopReason, stopDetail: detail, step: null })
}

function reviewInstruction(deps: RoundDeps, change: string, round: RoundRow, extra: PlanCheck[], acceptance: string[]): string {
  const execution = deps.executions.execution(round.executionId)!
  const changeRow = deps.executions.change(round.executionId, change)!
  const checks = (round.ci ?? []).map(check => `${check.name}: ${check.conclusion}`).join(', ')
  // Only the extra checks CI did not decide are the reviewer's to attest (D11).
  const reported = (round.ci ?? []).filter(check => check.conclusion.toLowerCase() === 'success').map(check => check.name)
  const extraLines = splitExtraChecks(extra, reported).attested.map(check => `- ${check.name}: ${check.description}${check.command ? ` (command: ${check.command})` : ''}`).join('\n')
  return [
    `Review the result ${round.resultId} of change "${change}" (round ${round.number}, commit ${round.commitSha}).`,
    changeRow.prUrl ? `Pull request: ${changeRow.prUrl}` : null,
    `CI: ${checks || 'none reported'}`,
    acceptance.length > 0 ? `Acceptance rules:\n${acceptance.map(rule => `- ${rule}`).join('\n')}` : null,
    extraLines !== '' ? `Extra checks to attest:\n${extraLines}` : null,
    `Submit your verdict with task_submit_findings on task ${changeRow.taskId} for result ${round.resultId}: pass or fail, with what you checked.`,
    'You are the independent reviewer: if you authored one of this change\'s results, do not review it — say so in a message to the Lead group instead.',
  ].filter(line => line !== null).join('\n\n') + `\n\nExecution ${execution.id} of plan ${execution.planId} at revision ${execution.revision}.`
}

// --- The round effects' adapters (D14): the runner calls them ---

/** The push effect: the implementer's own push counts; a moved branch never forces (plan-landing). */
export function pushAdapter(adapters: Pick<RoundAdapters, 'lsRemoteHead' | 'push'>): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const cwd = String(command.cwd ?? '')
      const commit = String(command.commit ?? '')
      const branch = String(command.branch ?? '')
      const head = await adapters.lsRemoteHead(cwd, `refs/heads/${branch}`)
      if (head.ok && head.sha === commit) return { ok: true, outcome: { head, pushedByKawai: false } }
      const pushed = await adapters.push(cwd, commit, branch)
      if (!pushed.ok) return { ok: false, error: pushed.error }
      return { ok: true, outcome: { head: commit, pushedByKawai: true } }
    },
  }
}

/** The open-pr effect: reuse the open pull request, create the change's one, stop on a closed one. */
export function openPrAdapter(adapters: Pick<RoundAdapters, 'prList' | 'prCreate'>, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const head = String(command.head ?? '')
      const base = String(command.base ?? '')
      const pulls = await adapters.prList(repo, { head, base }, ghOptions)
      if (!pulls.ok) return { ok: false, error: pulls.error }
      const open = pulls.data.find(pull => pull.state === 'OPEN')
      if (open) return { ok: true, outcome: { number: open.number, url: open.url, openedByKawai: false } }
      const closed = pulls.data.find(pull => pull.state === 'CLOSED')
      if (closed) {
        return { ok: false, error: { argv: ['gh', 'pr', 'list'], exitCode: 1, httpStatus: null, message: `Pull request ${closed.number} was closed without merging (pr-closed).` } }
      }
      const created = await adapters.prCreate(repo, { head, base, title: String(command.title ?? head), body: String(command.body ?? '') }, ghOptions)
      if (!created.ok) return { ok: false, error: created.error }
      return { ok: true, outcome: { number: created.data.number, url: created.data.url, openedByKawai: true } }
    },
  }
}

/** The rerun effect: the round's one rerun of failed Actions runs (D10). */
export function rerunAdapter(adapters: Pick<RoundAdapters, 'rerun'>, ghOptions?: GhCommandOptions): EffectAdapter {
  return {
    async call(effect) {
      const command = effect.command
      const repo = String(command.repo ?? '')
      const runIds = Array.isArray(command.runIds) ? command.runIds.filter((id): id is number => typeof id === 'number') : []
      for (const runId of runIds) {
        const rerun = await adapters.rerun(repo, runId, ghOptions)
        if (!rerun.ok) return { ok: false, error: rerun.error }
      }
      return { ok: true, outcome: { at: new Date().toISOString(), runIds } }
    },
  }
}
