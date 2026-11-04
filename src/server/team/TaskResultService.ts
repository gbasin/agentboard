// Results, findings, and acceptance (task-results-handoffs design D2/D4/D5).
// Identity comes from the calling session (agents) or the authenticated UI
// connection (the human), resolved through TaskService exactly as every task
// tool resolves it. Submission and findings are open to any member of the
// task's team — the cooperative trust model — and change no task status; the
// right that matters, closing the task, is TaskService.setStatus's own rule,
// evaluated before acceptance writes anything. Test outcomes and verdicts are
// claims: nothing here stores or implies verification.
import { partyName } from './actorRow'
import type { ChatSessionRecord } from '../db'
import { NULL_OWNERSHIP, type ExecutionOwnership } from '../plans/execution/executionOwnership'
import { isSealed, rawCoverage, validateCoverageMap, withheldCoverage } from '../../shared/coverageMaps'
import type { TaskResultCheck } from '../../shared/teamTasks'
import type { AssignmentTarget, TaskFindings, TaskHandoffKind, TaskResult, TaskTestClaim, TeamTask, TeamTaskAssignment, TeamTaskDetail, TeamTaskSummary } from '../../shared/teamTasks'
import { TASK_HANDOFF_KINDS } from '../../shared/teamTasks'
import { targetLabel, type AssignmentService } from './AssignmentService'
import type { MemberRelease } from './memberRelease'
import { TaskRelease } from './taskRelease'
import { statusRefusal, type TaskCaller, type TaskService } from './TaskService'
import { refuseSystem } from './systemCaller'
import type { TeamIdentity } from './teamIdentity'
import { worktreeRootOf } from './worktreeRoots'

export interface ResultSubmission {
  summary: string
  commit?: string | null
  diff?: string | null
  tests?: TaskTestClaim[]
  limitations?: string | null
  /** The submitter's coverage map (independent-verification D5); validated, never free text. */
  coverage?: unknown
}

export interface FindingsSubmission {
  resultId: string
  kind: TaskFindings['kind']
  verdict: TaskFindings['verdict']
  findings: string
}

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null)

export interface HandoffRequest {
  kind: TaskHandoffKind
  resultId: string
  target: AssignmentTarget
  instructions: string
  expectedResponse?: string | null
  /** The human's client request key; agents send none (D3). */
  requestKey?: string
  /** The role's profiles the review may route to (plan-execution D11/D15); honored for the system caller only. */
  allowedProfiles?: string[]
  /** Tags on the instruction mail (plan-execution D15: author-profile); the system caller only. */
  tags?: string[]
  /** The worker choice (dispatch-worker-choice D7): a group target only; never Kawai's. */
  worker?: string
}

export interface HandoffOutcome {
  assignment: TeamTaskAssignment
  /** True when an equivalent handoff already stood (agent retry) or the key replayed. */
  duplicate: boolean
  /** Why nothing new was dispatched; null when this call dispatched. */
  notice: string | null
}

const KIND_LABELS: Record<TaskHandoffKind, string> = { review: 'Review', qa: 'QA', fix: 'Fix' }
const DEFAULT_RESPONSE: Record<TaskHandoffKind, string> = {
  review: 'findings with task_submit_findings (kind review) on this result',
  qa: 'findings with task_submit_findings (kind qa) on this result',
  fix: 'a new result with task_submit_result',
}

/** The instruction a handoff carries: the request, the result it references, and what to send back (D3). */
export function handoffInstruction(kind: TaskHandoffKind, result: TaskResult, instructions: string, expectedResponse: string | null): string {
  const reference = [result.commit ? `commit ${result.commit}` : null, result.diff ? `diff ${result.diff}` : null].filter(Boolean).join(', ')
  return `${instructions}\n\n${KIND_LABELS[kind]} of result ${result.id} (${reference}): ${result.summary}\n` +
    `Expected response: ${expectedResponse ?? DEFAULT_RESPONSE[kind]}`
}

/** A check whose facts carry no coverage outcomes (D6): the outcomes reveal the withheld map's shape, so a sealed reader never sees them. */
function withoutCoverageOutcomes(check: TaskResultCheck): TaskResultCheck {
  if (check.facts === null || check.facts.coverage === undefined) return check
  const facts = { ...check.facts }
  delete facts.coverage
  return { ...check, facts }
}

/** What an acceptance closed, with what the human was shown before it (D5). */
export interface AcceptOutcome {
  task: TeamTask
  result: TaskResult
  /** The task's acceptance criteria — free text the system shows, never resolves. */
  acceptanceCriteria: string | null
  /** Child tasks not done or cancelled at acceptance. */
  openChildren: TeamTaskSummary[]
}

export class TaskResultService {
  /** Release worktree and hand off (D7); null without team-member-release. */
  readonly release: TaskRelease | null

  constructor(readonly tasks: TaskService, private readonly options: {
    getSession: (id: string) => ChatSessionRecord | null | undefined
    /** Handoffs dispatch through task-assignment's transaction (D3). */
    assignments?: AssignmentService
    /** Release-and-hand-off composes team-member-release's readiness, archive, and journal (D7). */
    releases?: MemberRelease
    records?: () => Iterable<ChatSessionRecord>
    homeDir?: string
    /** What a running execution owns (plan-execution D7/D9); the default owns nothing. */
    ownership?: ExecutionOwnership
    /** A result or findings write landed (plan-execution D5): the composition wakes the owner's executor. */
    onWrite?: (taskId: string) => void
    /** A result committed (independent-verification D1): the composition hands it to ResultCheckService. */
    onResult?: (result: TaskResult, teamId: string) => void
    /** A recheck was requested (independent-verification D4): the composition wakes the check service. */
    onRecheck?: (teamId: string) => void
  }) {
    this.release = options.releases && options.records
      ? new TaskRelease(this, {
        releases: options.releases, records: options.records,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
        ...(options.ownership ? { ownership: options.ownership } : {}),
      })
      : null
  }

  private get store() { return this.tasks.store }

  /** Whether a running execution owns the task (plan-execution D7): Kawai accepts it when the change lands. */
  ownedByExecution(taskId: string): boolean {
    return (this.options.ownership ?? NULL_OWNERSHIP).ownerOfTask(taskId) !== null
  }

  /**
   * Submit a result (D2): any agent of the task's team. The server pins the
   * task's current revision and worktree (the task's, else the submitter's
   * resolved worktree), journals one submitter-authored note — the result
   * news every task-mail recipient's journal excerpt carries — and leaves
   * the task's status alone: a submitted result is not a finished task.
   */
  async submit(caller: TaskCaller, taskId: string, input: ResultSubmission): Promise<TaskResult> {
    refuseSystem(caller, 'submit')
    const { team, actor } = await this.tasks.context(caller)
    if (actor.kind !== 'agent') throw new Error('Results are submitted by the agent that did the work, with task_submit_result')
    const task = this.tasks.sameTeamTask(team, taskId)
    const summary = input.summary.trim()
    if (!summary) throw new Error('A result needs a summary')
    const commit = blankToNull(input.commit)
    const diff = blankToNull(input.diff)
    if (!commit && !diff) throw new Error('A result needs a commit or a diff reference')
    const tests = (input.tests ?? []).map(row => ({ description: row.description.trim(), outcome: row.outcome.trim() }))
    if (tests.some(row => !row.description || !row.outcome)) throw new Error('Each test needs a description and an outcome')
    // The coverage map (independent-verification D5): validated before
    // anything is written, so a refused submission leaves no result row and
    // no check row (J1); the validated map is what the transaction stores.
    const coverage = input.coverage === undefined ? null : validateCoverageMap(input.coverage)
    // plan-execution D9: for an owned change, the commit must be on its
    // branch and contain origin's head of it, checked before anything is
    // written; the old holder of a Restarted change is refused outright
    // (revision-control D9, ruling L6).
    const refusal = await (this.options.ownership ?? NULL_OWNERSHIP).checkResult(taskId, { commit, submitter: actor.sessionId, kind: 'result' })
    if (refusal !== null) throw new Error(refusal)
    const session = this.options.getSession(actor.sessionId)
    // The result, its journal note, and the pending check row commit together
    // (independent-verification D1/I1): the check runs only after this
    // transaction commits, and a crash between loses nothing — the startup
    // run picks the pending row up. Nothing the check reads or computes
    // happens inside the transaction.
    const result = this.store.atomically(() => {
      const inserted = this.store.results.insert({
        teamId: team.teamId, taskId, summary, commit, diff,
        worktree: task.worktree ?? (session ? worktreeRootOf(session.projectPath) : null),
        tests, limitations: blankToNull(input.limitations), coverage, taskRevision: task.revision, submittedBy: actor,
      })
      this.store.appendJournal(taskId, actor, `Submitted result ${inserted.id}: ${summary}`)
      this.store.checks.insertPending({ teamId: team.teamId, taskId, resultId: inserted.id, trigger: 'submit', requestedBy: actor })
      return inserted
    })
    this.options.onWrite?.(taskId)
    this.options.onResult?.(this.store.results.get(result.id)!, team.teamId)
    return this.store.results.get(result.id)!
  }

  /**
   * Submit review or QA findings (D4), bound to the exact result examined —
   * a result of this task — and never to a later one. Open to any agent of
   * the team; the record names its author, so independence from the
   * submitter is visible. Answering the caller's outstanding handoff for that
   * result records its id (the attempt's identity).
   */
  async submitFindings(caller: TaskCaller, taskId: string, input: FindingsSubmission): Promise<TaskFindings> {
    refuseSystem(caller, 'submit')
    const { team, actor } = await this.tasks.context(caller)
    if (actor.kind !== 'agent') throw new Error('Findings are submitted by the reviewing agent, with task_submit_findings')
    this.tasks.sameTeamTask(team, taskId)
    const result = this.store.results.get(input.resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${input.resultId} is not a result of task ${taskId}`)
    const findings = input.findings.trim()
    if (!findings) throw new Error('Findings need text')
    // revision-control D9 (ruling L6): the old holder of a Restarted change
    // is refused findings like its result, judged from the rows, before
    // anything is written. Findings carry no commit and every stage accepted
    // them, so this is the only ownership check they run.
    const refusal = await (this.options.ownership ?? NULL_OWNERSHIP).checkResult(taskId, { commit: null, submitter: actor.sessionId, kind: 'findings' })
    if (refusal !== null) throw new Error(refusal)
    const handoff = this.store.outstandingAssignment(taskId)
    const answers = handoff?.handoffKind && handoff.resultId === result.id && handoff.claimedBy === actor.sessionId
    const stored = this.store.results.insertFindings({
      teamId: team.teamId, taskId, resultId: result.id, handoffId: answers ? handoff.id : null,
      kind: input.kind, verdict: input.verdict, findings, author: actor,
    })
    this.store.appendJournal(taskId, actor, `${input.kind === 'qa' ? 'QA' : 'Review'} findings on result ${result.id}: ${input.verdict}`)
    this.options.onWrite?.(taskId)
    return stored
  }

  /**
   * Record the session's own coverage map for a result (independent-
   * verification D6, "reviewers record their own coverage map first"):
   * validated exactly like a submission's map — the refusal names the clause
   * index and writes nothing (J1) — then appended to the append-only
   * table. Recording a map for the result its outstanding review handoff
   * names unseals the task's submitter maps for this session. The task's
   * status is nobody's business here.
   */
  async submitCoverage(caller: TaskCaller, taskId: string, input: { resultId: string; coverage: unknown }): Promise<TaskResult> {
    refuseSystem(caller, 'submit')
    const { team, actor } = await this.tasks.context(caller)
    if (actor.kind !== 'agent') throw new Error('Coverage maps are recorded by the member that made them, with task_submit_coverage')
    this.tasks.sameTeamTask(team, taskId)
    const result = this.store.results.get(input.resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${input.resultId} is not a result of task ${taskId}`)
    const coverage = validateCoverageMap(input.coverage)
    this.store.checks.insertCoverageMap({
      teamId: team.teamId, taskId, resultId: result.id, authorSession: actor.sessionId,
      coverage: JSON.stringify(coverage),
    })
    this.options.onWrite?.(taskId)
    // The return is a read like any other, so it passes through the same
    // seal: mapping a result other than the handoff's returns the withheld
    // stub; mapping the handoff's own unseals, and the call returns the raw
    // pair with the comparison.
    const fresh = this.store.results.get(result.id)!
    const joined = { ...fresh, reviewerMaps: this.store.results.reviewerMapsOf(fresh.id, rawCoverage(fresh.coverage)) }
    return this.sealResults(actor.sessionId, taskId, [joined])[0]!
  }

  /**
   * The reader's view of a task detail (D6/D12): the human sees everything;
   * a sealed reader — the holder of the task's outstanding review handoff
   * with no map recorded for its result — sees every submitter map withheld
   * down to `{ withheld, clauses }`, its own reviewer-map rows without their
   * comparisons, no comparison of its own, and no coverage outcomes in any
   * check facts (the outcomes give the map's shape away). Unsealed, the
   * reading session's own comparison rides the result.
   */
  applySeal<T extends Pick<TeamTaskDetail, 'results'>>(caller: TaskCaller, taskId: string, detail: T): T {
    if (caller.kind !== 'agent' || detail.results === undefined) return detail
    return { ...detail, results: this.sealResults(caller.sessionId, taskId, detail.results) }
  }

  /**
   * The seal projection over a list of results (D6) — the one implementation
   * behind every agent reader surface: task_get's applySeal and
   * task_submit_coverage's return alike, so recording a map through the tool
   * can never hand back more than the reader may see. The predicate is
   * evaluated at read time: a call that records the handoff result's own map
   * reads unsealed here, because its insert has already landed.
   */
  private sealResults(sessionId: string, taskId: string, results: TaskResult[]): TaskResult[] {
    const outstanding = this.store.outstandingAssignment(taskId)
    const handoffResultId = outstanding?.handoffKind === 'review' ? outstanding.resultId ?? null : null
    const sealed = handoffResultId !== null &&
      isSealed(outstanding ?? null, sessionId, this.store.checks.hasCoverageMap(handoffResultId, sessionId))
    return results.map(result => {
      if (sealed) {
        const ownMaps = (result.reviewerMaps ?? []).filter(row => row.authorSession === sessionId)
          .map(row => ({ ...row, comparison: null }))
        const checks = result.checks
          ? { ...result.checks, newest: result.checks.newest === null ? null : withoutCoverageOutcomes(result.checks.newest) }
          : undefined
        return {
          ...result,
          // detail() carries the raw map; the withheld form exists only here.
          coverage: withheldCoverage(rawCoverage(result.coverage)),
          reviewerMaps: ownMaps, comparison: null, ...(checks ? { checks } : {}),
        }
      }
      const ownNewest = (result.reviewerMaps ?? []).find(row => row.authorSession === sessionId)
      return { ...result, comparison: ownNewest?.comparison ?? null }
    })
  }

  /**
   * Request a new check of a result (independent-verification D4): the
   * human, or any team member. A request made while a check is pending
   * returns the standing pending row instead of starting another; a new row
   * is recorded beside the earlier ones, which stay readable. The request
   * never runs the check itself — the composition wakes the service, which
   * runs it outside every gate.
   */
  async recheck(caller: TaskCaller, taskId: string, resultId: string): Promise<TaskResultCheck> {
    refuseSystem(caller, 'recheck')
    const { team, actor } = await this.tasks.context(caller)
    this.tasks.sameTeamTask(team, taskId)
    const result = this.store.results.get(resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${resultId} is not a result of task ${taskId}`)
    const { check } = this.store.checks.insertPending({
      teamId: team.teamId, taskId, resultId: result.id, trigger: 'recheck', requestedBy: actor,
    })
    this.options.onRecheck?.(team.teamId)
    return check
  }

  /**
   * Accept a result (D5): the human, or the task's creator agent — the exact
   * closing rule TaskService.setStatus enforces, checked first, so a refusal
   * writes nothing. A result labeled Needs re-evaluation, or child tasks
   * still open, require a stated reason. Then the result's acceptance, the
   * acceptor's journal entry, and the `done` status commit in one
   * transaction (setStatus's own, with its transition hook). Acceptance is
   * per task: no parent is touched.
   */
  async accept(caller: TaskCaller, taskId: string, resultId: string, reason?: string): Promise<AcceptOutcome> {
    refuseSystem(caller, 'accept')
    const { team, actor } = await this.tasks.context(caller)
    const task = this.tasks.sameTeamTask(team, taskId)
    const refusal = statusRefusal(actor, task, 'done')
    if (refusal) throw new Error(refusal.replace(`set it to done`, 'accept its results and close it'))
    // plan-execution D7/D19: ownership guards dispatch, handoff, and release,
    // never acceptance. A human accept of an owned task closes it like any
    // close: the executor stops the change as task-closed and merges nothing.
    // The task view does not offer it for an owned task, so this is not a prompt to accept.
    const result = this.store.results.get(resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${resultId} is not a result of task ${taskId}`)
    const openChildren = this.store.list(team.teamId).filter(child =>
      child.parentId === taskId && child.status !== 'done' && child.status !== 'cancelled')
    const flags = [
      ...(result.needsReevaluation ? [`needs re-evaluation (pinned at revision ${result.taskRevision}, task at ${task.revision})`] : []),
      ...(openChildren.length > 0 ? [`${openChildren.length} open child task${openChildren.length === 1 ? '' : 's'}`] : []),
    ]
    const stated = reason?.trim()
    if (flags.length > 0 && !stated) throw new Error(`Accepting despite ${flags.join(' and ')} needs a stated reason; nothing was accepted.`)
    const entry = flags.length > 0 ? `Accepted result ${resultId} despite ${flags.join(' and ')}: ${stated}` : `Accepted result ${resultId}`
    const closed = await this.tasks.setStatus(caller, taskId, 'done', undefined, () => {
      this.store.results.markAccepted(resultId, actor)
      this.store.appendJournal(taskId, actor, entry)
    })
    return { task: closed, result: this.store.results.get(resultId)!, acceptanceCriteria: task.acceptance, openChildren }
  }

  /**
   * Hand a result off (D3): a review, QA, or fix assignment to a role,
   * dispatched through task-assignment's transaction with the handoff fields
   * in its payload identity. The human sends a client request key (a replay
   * returns the prior handoff; another result under it is refused). Agents
   * send none: while an equivalent handoff — same task, result, and kind —
   * stands (not superseded, not failed), a retried call returns it with a
   * notice instead of dispatching again; a failed one loses standing.
   */
  /** A handoff's canonical worker choice (dispatch-worker-choice D7), refused like the dispatch refuses it. */
  workerChoice(caller: TaskCaller, team: TeamIdentity, target: AssignmentTarget, raw: string | undefined): string | null {
    if (!this.options.assignments) throw new Error('Handoffs are not available')
    return this.options.assignments.workerChoice(caller, team, target, raw)
  }

  async handoff(caller: TaskCaller, taskId: string, request: HandoffRequest): Promise<HandoffOutcome> {
    refuseSystem(caller, 'handoff')
    const { team } = await this.tasks.context(caller)
    this.tasks.sameTeamTask(team, taskId)
    // Only Kawai hands a running change's task to its next stage (plan-execution D7).
    const owner = (this.options.ownership ?? NULL_OWNERSHIP).ownerOfTask(taskId)
    if (owner !== null && caller.kind !== 'system') {
      throw new Error(`The task is owned by a running execution (${owner.executionId}); close the task or stop the execution instead. Nothing was dispatched.`)
    }
    if (!TASK_HANDOFF_KINDS.includes(request.kind)) throw new Error(`Unknown handoff kind: ${String(request.kind)}`)
    const result = this.store.results.get(request.resultId)
    if (!result || result.taskId !== taskId) throw new Error(`Result ${request.resultId} is not a result of task ${taskId}`)
    const instructions = request.instructions.trim()
    if (!instructions) throw new Error('A handoff needs instructions')
    if (!this.options.assignments) throw new Error('Handoffs are not available')
    const expectedResponse = request.expectedResponse?.trim() || null
    // Normalized before the equivalent check (D7): a retry naming another worker is another handoff.
    const workerChoice = this.options.assignments.workerChoice(caller, team, request.target, request.worker)
    if (caller.kind === 'agent') {
      const standing = this.tasks.store.assignmentsOf(taskId).find(row => row.handoffKind === request.kind &&
        row.resultId === result.id && (row.workerChoice ?? null) === workerChoice && row.supersededBy === null && row.state !== 'failed')
      if (standing) {
        // The standing recipient is exposed (session-targeted-task-handoffs
        // D3): kind, id, and — when the request names another recipient — both
        // sides, so a retry can never look like a silent reassignment.
        const storedTarget = { kind: standing.targetKind, id: standing.targetId }
        const asked = targetLabel(request.target)
        const mismatch = storedTarget.kind === request.target.kind && storedTarget.id === request.target.id ? '' :
          ` You asked for ${asked}, which differs from the standing ${targetLabel(storedTarget)}: no reassignment occurred — inspect the standing assignment (${standing.id}).`
        return { assignment: standing, duplicate: true,
          notice: `An equivalent ${request.kind} handoff of result ${result.id} is already outstanding (${standing.id}, dispatched by ` +
            `${partyName(standing.createdBy)}, ${standing.state}) to ${targetLabel(storedTarget)}; nothing was dispatched again.${mismatch}` }
      }
    }
    const outcome = await this.options.assignments.dispatch(caller, {
      taskId, target: request.target,
      instruction: handoffInstruction(request.kind, result, instructions, expectedResponse),
      requestKey: request.requestKey?.trim() || `handoff-${crypto.randomUUID()}`,
      handoff: { kind: request.kind, resultId: result.id, expectedResponse },
      ...(request.allowedProfiles ? { allowedProfiles: request.allowedProfiles } : {}),
      ...(request.tags ? { tags: request.tags } : {}),
      ...(request.worker !== undefined ? { worker: request.worker } : {}),
    })
    return { assignment: outcome.assignment, duplicate: outcome.replay,
      notice: outcome.replay ? 'This request was already dispatched; the earlier handoff is returned.' : null }
  }
}
