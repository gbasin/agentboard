// The one production composition of the plan services (plan-validation D9's
// production wiring, extracted from ChatSessionManager so tests exercise the
// same construction the server runs): the ValidationService over the shared
// plan store, its adapter and capacity evidence, the coalesced validation
// view for the Plans page pushes, the PlanService with validation's
// `validation-current` appended after the shipped approval preconditions,
// and — with team services given — the execution runtime: the executor with
// the real adapters (fixture adapters under the development fixture switch),
// D14 startup recovery, every D5 wake, and the stop path. Both the manager
// and the test benches call `composePlanServices`; nothing else may wire
// these services by hand.
import type { Database } from 'bun:sqlite'
import type { ChatSessionRecord } from '../db'
import type { TeamIdentity } from '../team/teamIdentity'
import { loadGroupCatalog } from '../team/groupCatalog'
import type { StrategyStore } from '../strategy/strategyStore'
import type { ImpactService } from '../strategy/ImpactService'
import { carriedConditionsOf, type ValidationCapacityEvidence } from '../../shared/planValidation'
import type { PlanStore } from './planStore'
import { PlanService } from './PlanService'
import { PlanWorkspaceStore } from './workspace/workspaceStore'
import { PlanWorkspaceRefs } from './workspace/workspaceRefs'
import { PlanWorkspaceContext } from './workspace/workspaceContext'
import { OpenspecAdapter } from './validation/openspecAdapter'
import { ValidationService } from './validation/ValidationService'
import { ValidationStore } from './validation/validationStore'
import { ValidationDetailCache } from './validation/validationDetail'
import { ExecutionStore } from './execution/executionStore'
import { ExecutionService } from './execution/ExecutionService'
import { ExecutionRevisionStore } from './revisionControl/executionRevisionStore'
import { executionOwnership, ownershipRowReads, type ExecutionOwnership } from './execution/executionOwnership'
import { executionViewReads, executionViews } from './execution/executionView'
import { ExecutionExecutor } from './execution/executor'
import { ExecutionRuntime, ExecutionWakes } from './execution/executionRuntime'
import { provisionAdapter } from './execution/executionProvision'
import { roundAdapters } from './execution/executionRounds'
import { fixtureLandingAdapters, fixtureRoundAdapters, FIXTURE_FLOOR } from './execution/fixtureAdapters'
import { fixtureInspectorReads, fixtureMechanisms, fixturePromotionAdapters, fixturePromotionProbe, fixturePromotionReads } from './landing/integration/fixtureIntegrationAdapters'
import { chatFixtureEnabled } from '../chat/developmentFixture'
import type { LandingMechanisms } from './landing/landingMechanisms'
import { directMechanism } from './landing/directMechanism'
import { IntegrationStore } from './landing/integration/integrationStore'
import { integrationViews } from './landing/integration/integrationView'
import { integrationMechanism } from './landing/integration/integrationMechanism'
import { composePromotions } from './landing/integration/promotionComposition'
import type { PromotionService } from './landing/integration/PromotionService'
import type { MemberRelease } from '../team/memberRelease'
import type { TaskService } from '../team/TaskService'
import type { TaskResultService } from '../team/TaskResultService'
import type { AssignmentService } from '../team/AssignmentService'
import type { MailboxStore } from '../team/mailboxStore'
import type { TeamMailbox } from '../team/TeamMailbox'
import { DecisionService } from './decisions/DecisionService'
import { DecisionStore } from './decisions/decisionStore'
import { HoldService } from './revisionControl/holdService'
import { HoldStore } from './revisionControl/holdStore'
import { PauseStore } from './revisionControl/pauseStore'
import { PauseService } from './revisionControl/pauseService'
import { restartReleaseSeams, reviewRestartSeam } from './revisionControl/pauseRestart'
import { AssignmentStore } from '../team/assignmentStore'
import { CheckpointStore } from './revisionControl/checkpointStore'
import type { PauseTickDeps } from './revisionControl/pauseTick'
import { CheckpointTool } from './revisionControl/checkpointTool'
import type { ActiveHold } from '../../shared/planRevisionControl'
import { readPlanSupervisionDetail, type SupervisionDetailReads } from './supervision/planSupervisionDetail'
import type { SupervisionRuntime } from './supervision/supervisionRead'
import { composeSupervisionMonitor, type MonitorCompositionOptions } from './supervision/monitorComposition'
import type { SupervisionMonitor } from './supervision/SupervisionMonitor'
import type { TaskStore } from '../team/taskStore'
import type { PlanExecutionSettings } from '../team/teamCaps'

/** What capacity evidence reads: staffing's counts and the cooldown ends (D3). */
export interface CapacityReads {
  capacity: (teamId: string, groupId: string, worktree: string) => { groupMembers: number; onProfile: Record<string, number> }
  cooldownUntil: (profileId: string) => string | null
}

/** The team services the execution runtime drives and wakes on (plan-execution D5). */
export interface ExecutionTeamServices {
  tasks: TaskService
  assignments: AssignmentService
  results: TaskResultService
  /** The task store (TaskStore.changed wakes) and the mailbox (owned mail wakes). */
  taskStore: TaskStore
  mailbox: MailboxStore
  /** The team mailbox whose prepared send/reply paths carry decision mail (plan-supervision D4–D6). */
  teamMailbox: TeamMailbox
  /** The holder facts and mailbox blockers the supervision detail reads (plan-supervision D10); absent, the detail carries no supervision. */
  supervision?: SupervisionRuntime
  /** Member release's readiness and release (the D11 release-before-review seam). */
  releases: MemberRelease
  /** The pause tick's live holder facts (revision-control D8): state, request, busy, provider limit. */
  pauseFacts: (sessionId: string) => import('./revisionControl/pauseTick').PauseHolderRuntimeFacts
  /** Staffing's in-flight spawn reservations: a member still starting holds the D11 release step. */
  pendingSpawns: (teamId: string) => Array<{ groupId: string; worktree: string }>
  records: () => Iterable<ChatSessionRecord>
  /** The team's identity by team id — the executor's ticks resolve teams this way. */
  identityOf: (teamId: string) => TeamIdentity | undefined
  /** The session's team — the runtime's archive wake resolves sessions this way. */
  teamOfSession: (sessionId: string) => TeamIdentity | undefined
}

/** The store, the real ownership over it, and the pre-runtime wake hub. */
export interface ExecutionCore {
  executionStore: ExecutionStore
  ownership: ExecutionOwnership
  wakes: ExecutionWakes
}

/**
 * The execution store, its ownership, and the wake hub — built before the
 * team services (they take the ownership) and shared with
 * `composePlanServices`, so the whole server runs one ExecutionStore.
 */
export function composeExecutionCore(db: Database): ExecutionCore {
  const executionStore = new ExecutionStore(db)
  const ownership = executionOwnership(executionStore, {
    isAncestor: (...args) => import('./landing/gitRemote').then(module => module.isAncestor(...args)),
    lsRemoteHead: (...args) => import('./landing/gitRemote').then(module => module.lsRemoteHead(...args)),
  }, messageId => {
    const row = db.prepare('SELECT from_kind FROM team_messages WHERE id = ?').get(messageId) as { from_kind?: string } | undefined
    return row?.from_kind === 'system' ? 'system' : row === undefined ? null : row.from_kind === 'human' ? 'human' : 'agent'
  }, ownershipRowReads(db))
  return { executionStore, ownership, wakes: new ExecutionWakes(executionStore, ownership) }
}

export interface PlanServicesOptions {
  db: Database
  /** The mailbox's shared plan store — the same one the task link reads. */
  plans: PlanStore
  strategies: StrategyStore
  impact: ImpactService
  getSession: (id: string) => ChatSessionRecord | null | undefined
  /** The user-level settings (plan-execution D16); without it Start refuses on the missing floor map. */
  caps?: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }
  /** The pre-built execution core (one store for the whole server); built here when absent. */
  executionCore?: ExecutionCore
  /**
   * The team services: given, the composition constructs the executor with
   * the real adapters and the runtime (boot recovery, D5 wakes, stop).
   */
  executionTeam?: ExecutionTeamServices
  /** Test seam: replace the execution pre-reads' validation standing (defaults to the composed service). */
  executionValidation?: {
    prepareStanding: (planId: string, revision: number) => Promise<unknown> | null
    standing: (prepared: unknown) => unknown
  }
  /** Test seam: replace the landing probe (defaults to the real one; the fixture switch its own). */
  executionProbe?: (input: import('./landing/landingProbe').ProbeInput, options?: import('./landing/ghCommand').GhCommandOptions) => Promise<import('./landing/landingProbe').ProbeResult>
  /** Test seam: the supervision monitor's clock, timer, debounce, and log. */
  monitor?: MonitorCompositionOptions['monitor']
  /** Test seam: the Promote reads (origin heads, containment, the merge-commit setting). */
  promotionReads?: import('./landing/integration/PromotionService').PromotionReads
  /** Test seam: the gh surface every composed gh call uses (a stub gh on a private PATH). */
  executionGhOptions?: import('./landing/ghCommand').GhCommandOptions
  /** One adapter per manager by default (one 4-slot CLI pool per process). */
  adapter?: OpenspecAdapter
  /** Without staffing or limit reads, the capacity check shows no evidence row. */
  capacityReads?: CapacityReads
  homeDir?: string
}

/**
 * Capacity evidence for one role group (plan-validation D3): the group's
 * caps, live members, and cooling profiles with their cooldown end, read
 * from the team's OWN groups root — never re-resolved from the common git
 * dir, whose `.git` tail would miss project group files (M2). Evidence
 * only; never a blocker.
 */
export function capacityEvidenceFor(identity: TeamIdentity, group: string, reads: CapacityReads, homeDir?: string): ValidationCapacityEvidence | null {
  const entry = loadGroupCatalog({ groupsRoot: identity.groupsRoot, ...(homeDir ? { homeDir } : {}) }).groups.get(group)
  if (!entry) return null
  const capacity = reads.capacity(identity.teamId, group, identity.groupsRoot)
  return {
    group,
    max: entry.group.max,
    live: capacity.groupMembers,
    profiles: entry.group.profiles.map(profile => ({
      profile: profile.profileId,
      cap: profile.cap ?? null,
      live: capacity.onProfile[profile.profileId] ?? 0,
    })),
    cooling: entry.group.profiles
      .flatMap(profile => {
        const until = reads.cooldownUntil(profile.profileId)
        return until === null ? [] : [{ profile: profile.profileId, until }]
      }),
  }
}

/** The composed plan services: what ChatSessionManager and the benches construct. */
export function composePlanServices(options: PlanServicesOptions): {
  validation: ValidationService
  validationStore: ValidationStore
  plans: PlanService
  validationDetail: ValidationDetailCache
  adapter: OpenspecAdapter
  executions: ExecutionService
  executionStore: ExecutionStore
  /** The execution runtime (boot, wakes, stop); null without team services. */
  runtime: ExecutionRuntime | null
  /** Promote, Cancel, and the preview (integration-candidates D9). */
  promotions: PromotionService
  /** The integration branches, candidates, promotions, and promotion effects; its writes re-push plan details (D13). */
  integrationStore: IntegrationStore
  /** The workspace's bindings and command ledger (plan-workspace 1.2). */
  workspaceStore: PlanWorkspaceStore
  /** The workspace's document references and their keyed add/remove (plan-workspace 1.2). */
  workspaceRefs: PlanWorkspaceRefs
  /** The workspace's per-message context snapshots (plan-workspace 1.2); chat delivery is PR D. */
  workspaceContext: PlanWorkspaceContext
  /** The decision service (plan-supervision D4–D7); null without team services. */
  decisions: DecisionService | null
  /** The owner's hold commands (revision-control 3.1): place, release (whole, by changes, narrowed), extend. */
  holds: HoldService
  /** The supervision monitor (plan-supervision D11); null without team services' supervision runtime. Started by its owner. */
  monitor: SupervisionMonitor | null
  /** The supervision reads (plan-supervision D13); null without team services' supervision runtime. */
  supervisionReads: SupervisionDetailReads | null
  /** The `task_checkpoint` tool (revision-control D7); also the executor's round-push → result-checkpoint recorder. */
  checkpoints: CheckpointTool
  /** The owner's pause commands (revision-control D6); the executor's owed-mail pass reads through it. Null without team services. */
  pauses: PauseService | null
} {
  const adapter = options.adapter ?? new OpenspecAdapter()
  const validationStore = new ValidationStore(options.db)
  const validation = new ValidationService(validationStore, {
    plans: options.plans,
    strategies: options.strategies,
    impact: options.impact,
    adapter,
    getSession: options.getSession,
    capacity: options.capacityReads
      ? (team: TeamIdentity, group: string) => capacityEvidenceFor(team, group, options.capacityReads!, options.homeDir)
      : undefined,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  const core = options.executionCore ?? composeExecutionCore(options.db)
  const executionStore = core.executionStore
  const viewReads = executionViewReads(options.plans, options.db)
  // D19: closing a plan stops its running executions as Kawai. The hook is
  // late-bound — the execution service needs this PlanService — and is set
  // before this function returns, so no close can find it unbound.
  let executions: ExecutionService | null = null
  const integrationStore = new IntegrationStore(options.db)
  // The hold gate's reads (revision-control 3.2), shared by the executor and
  // Start/Promote: the plan's active holds and open pause targets, read at
  // each call so a placed or released hold reaches the next tick.
  const holdStore = new HoldStore(options.db)
  const pauseStore = new PauseStore(options.db)
  const holdsOf = (teamId: string, planId: string): ActiveHold[] =>
    holdStore.active(teamId, planId).map(hold => ({ id: hold.id, scope: hold.scope, changes: hold.changes }))
  const openTargetsOf = (teamId: string, planId: string) =>
    pauseStore.forPlan(teamId, planId, true).flatMap(pause =>
      pauseStore.targets(pause.id).map(target => ({ pauseId: pause.id, change: target.change, decision: target.decision })))
  // The execution's unresolved acceptance conditions (V2): landing and supervision read the same ones.
  const conditionsOf = (executionId: string): string[] => {
    const execution = executionStore.execution(executionId)
    if (execution === null) return []
    const assessments = validationStore.assessments(execution.planId, execution.revision)
    const decisions = validationStore.decisions(execution.planId, execution.revision)
    return carriedConditionsOf(assessments, decisions)
      .filter(condition => condition.gate === 'acceptance' && !condition.resolved)
      .map(condition => condition.text)
  }
  // Set once the team services exist; the detail reads it at each push (plan-supervision D15/D16).
  let supervisionReads: SupervisionDetailReads | null = null
  // The pause service (revision-control D6), built with the team services; null without them.
  let composedPauses: PauseService | null = null
  const plans = new PlanService(options.plans, {
    getSession: options.getSession,
    strategies: options.strategies,
    pinDisposition: (planId, revision) => options.impact.pinDisposition(planId, revision),
    validation: {
      prepareStanding: (planId, revision) => validation.prepareStanding(planId, revision),
      standing: prepared => validation.standing(prepared as Parameters<ValidationService['standing']>[0]),
      precondition: ValidationService.validationCurrentPrecondition(),
    },
    executionOf: executionId => {
      const execution = executionStore.execution(executionId)
      return execution ? { planId: execution.planId, revision: execution.revision } : null
    },
    executionsOf: planId => executionViews(executionStore, planId, viewReads),
    integrationOf: planId => integrationViews(integrationStore, planId),
    supervisionOf: (teamId, planId) => (supervisionReads === null ? null : readPlanSupervisionDetail(supervisionReads, teamId, planId, new Date())),
    onPlanClosed: async planId => {
      const plan = options.plans.get(planId)
      if (plan !== null && plan !== undefined) await executions?.stopForPlan(plan.teamId, planId)
    },
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  // The runtime binds the executor after this function returns; a committed
  // command wakes through it, so a Start racing boot recovery wakes only
  // once recovery has ended and the running teams are woken.
  let runtime: ExecutionRuntime | null = null
  const team = options.executionTeam
  // The registered landing mechanisms (integration-candidates D1): built once here and
  // passed to the Start service, the executor, and the provision adapter (I1).
  // Under the development fixture both probe through the fixture probe and
  // the integration mechanism writes refs on the fixture's bare origin
  // (`fixtureIntegrationAdapters.ts`), so nothing calls the real gh.
  const fixture = chatFixtureEnabled
  const mechanisms: LandingMechanisms = fixture ? fixtureMechanisms(integrationStore) : new Map([
    [directMechanism.mode, directMechanism],
    ['integration-branch', integrationMechanism(integrationStore)],
  ])
  executions = new ExecutionService({
    store: executionStore,
    plansStore: options.plans,
    plans,
    // revision-control D2: Start records the execution's seq-1 revision.
    executionRevisions: new ExecutionRevisionStore(options.db),
    validation: options.executionValidation ?? {
      prepareStanding: (planId: string, revision: number) => validation.prepareStanding(planId, revision),
      standing: (prepared: unknown) => validation.standing(prepared as Parameters<ValidationService['standing']>[0]),
    },
    impact: { gate: (planId, revision) => options.impact.gate(planId, revision) },
    settings: executionSettings(options.caps),
    getSession: options.getSession,
    landingModes: () => new Set(mechanisms.keys()),
    mechanisms,
    // D8's promotion-idle pre-read: the plan's running promotion, named with its step.
    promotions: {
      runningPromotion: planId => {
        const running = integrationStore.runningPromotion(planId)
        return running === null ? null : { id: running.id, number: running.number, branch: running.branch, step: running.step }
      },
    },
    identityOf: teamId => identityOrBare(team, teamId),
    // revision-control 3.3: `no-hold` reads the same active holds as the gate.
    holds: { active: holdsOf },
    ...(team !== undefined ? {
      tasks: team.tasks,
      wake: (teamId: string) => runtime?.command(teamId),
    } : {}),
    ...(options.executionGhOptions ? { ghOptions: options.executionGhOptions } : {}),
    ...(options.executionProbe ? { probe: options.executionProbe } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  })
  // Promotions (D9, D10): the slot holder kind, the service, and the runner the executor ticks.
  const promotions = composePromotions({
    integration: integrationStore, executions: executionStore, plans, plansStore: options.plans,
    settings: executionSettings(options.caps), identityOf: teamId => identityOrBare(team, teamId),
    wake: teamId => runtime?.command(teamId),
    ...(options.executionGhOptions ? { ghOptions: options.executionGhOptions } : {}),
    ...(options.executionProbe ? { probe: options.executionProbe } : fixture ? { probe: fixturePromotionProbe } : {}),
    ...(options.promotionReads ? { reads: options.promotionReads } : fixture ? { reads: fixturePromotionReads() } : {}),
    ...(fixture ? { adapters: fixturePromotionAdapters(), inspectorReads: fixtureInspectorReads() } : {}),
    // revision-control 3.3: `no-hold` and the runner's held step read the same holds.
    holds: { active: holdsOf },
  })
  // Checkpoints (revision-control D7): the tool the Pausing holder calls,
  // and the recorder that counts a round's done push as the `result`
  // checkpoint. The git reads are the tool's own; the results name the
  // submitter a `result` checkpoint carries. The store is shared with the
  // tick's pause pass, which reads each target's newest checkpoint.
  const checkpointStore = new CheckpointStore(options.db)
  const checkpoints = new CheckpointTool({
    executions: executionStore, pauses: pauseStore, checkpoints: checkpointStore,
    ...(team !== undefined ? {
      resultOf: resultId => {
        const result = team.results.tasks.store.results.get(resultId)
        return result === null ? null : { sessionId: result.submittedBy.kind === 'agent' ? result.submittedBy.sessionId : null }
      },
    } : {}),
  })
  if (team !== undefined) {
    const roundAdaptersUsed = fixture ? fixtureRoundAdapters() : roundAdapters
    // The pause service (revision-control D6): the owner's command — and,
    // for the tick (D8), the owed-mail pass over a spawn's or forward's
    // claim, whose once-marker is the target's stored message_id.
    const assignments = new AssignmentStore(options.db, team.mailbox)
    const pauses = new PauseService({
      pauses: pauseStore, holds: holdStore, plans: options.plans, planService: plans, executions: executionStore,
      // The assignment reads (the outstanding instruction, the withdrawal's
      // supersede) over the shared table; the service-owned instance keeps
      // its claim copies current (supervisionRead builds its reader the
      // same way).
      assignments, mailbox: team.mailbox,
      sessionExists: id => options.getSession(id) !== undefined,
      sessionProfile: id => options.getSession(id)?.claudeProfileId ?? null,
      // The resolve's task revisions, checkpoint reads, and inline fix
      // dispatch (revision-control 4.4). L3 (A3.2): the resolve's
      // pre-transaction head read is wired — origin's branch head through
      // the same adapter the executor's landing reads; a failed read is
      // refused `head-unreadable` inside the resolve (K7).
      tasks: team.tasks, checkpoints: checkpointStore, assignmentService: team.assignments,
      adaptHead: async (executionId, change) => {
        const row = executionStore.change(executionId, change)
        const teamId = executionStore.execution(executionId)?.teamId
        const identity = teamId !== undefined ? team.identityOf(teamId) : undefined
        if (row === null || row.branch === null || identity === undefined) return null
        const head = await import('./landing/gitRemote').then(module => module.lsRemoteHead(row.worktree ?? identity.groupsRoot, `refs/heads/${row.branch}`))
        if (!head.ok || head.sha === null) return { ok: false }
        return { ok: true, startCommit: head.sha, artifacts: {} }
      },
      wake: teamId => runtime?.command(teamId),
      // R2's release bookkeeping (rev4 §4): the team's MemberRelease behind
      // the resolve's structural seams — a ready spawned holder is released
      // after the resolve's commit, a busy one marked pending inside the
      // transaction; unwired, the detail reads release 'never'.
      ...restartReleaseSeams(team.releases, id => options.getSession(id)),
    })
    composedPauses = pauses
    const executor = new ExecutionExecutor({
      mechanisms,
      store: executionStore,
      plans: options.plans,
      tasks: team.tasks,
      assignments: team.assignments,
      results: team.results,
      records: team.records,
      mailbox: team.mailbox,
      plansService: plans,
      teamOf: team.identityOf,
      releases: {
        readiness: sessionId => {
          const readiness = team.releases.readiness(sessionId)
          return readiness.ready ? { ready: true, reason: null } : { ready: false, reason: readiness.reason }
        },
        release: (sessionId, detail) => team.releases.releaseNow(sessionId, detail ?? ' before the review handoff (plan-execution D11)'),
        pendingSpawns: team.pendingSpawns,
      },
      conditionsOf,
      adapters: { provision: provisionAdapter(executionStore, undefined, mechanisms) },
      groupScoped: (teamId, groupId) => groupScopedOf(team, teamId, groupId),
      holds: { active: holdsOf, openTargets: openTargetsOf },
      // LC1: the planner's owed review-restart stage dispatches through the
      // pause side's stores — the newest restart decision names the pause
      // whose recorded notes ride the instruction.
      reviewRestart: reviewRestartSeam({
        pauses: pauseStore, checkpoints: checkpointStore, executions: executionStore,
        plans: options.plans, tasks: team.tasks, assignments: team.assignments,
      }),
      checkpoints,
      // revision-control D8 (4.3): the tick's pause pass — the owed mail,
      // then Paused recorded from stored rows and the live holder facts,
      // and a settled pause closed.
      pauses: {
        pauses: pauseStore, checkpoints: checkpointStore, executions: executionStore, mailbox: team.mailbox,
        deliverOwed: (teamId, groupsRoot, pauseId) => pauses.deliverOwed(teamId, groupsRoot, pauseId),
        // F5: `starting` names an unclaimed spawn only — a forward successor
        // that has not claimed reads as its owed mail.
        assignmentMessageState: assignmentId => {
          const row = assignments.byId(assignmentId)
          return row?.messageId != null ? team.mailbox.get(row.messageId)?.state ?? null : null
        },
        readiness: sessionId => {
          const answer = team.releases.readiness(sessionId)
          return answer.ready ? { ready: true, reason: null } : { ready: false, reason: answer.reason }
        },
        factsOf: team.pauseFacts,
      } satisfies PauseTickDeps,
      roundAdapters: roundAdaptersUsed,
      ...(fixture ? { landingAdapters: fixtureLandingAdapters(), tickMs: 1_000 } : {}),
      ...(options.executionGhOptions ? { ghOptions: options.executionGhOptions } : {}),
      promotions: promotions.runner,
    })
    runtime = new ExecutionRuntime({
      executor, store: executionStore, ownership: core.ownership, wakes: core.wakes,
      taskStore: team.taskStore, mailbox: team.mailbox, records: team.records, teamOf: team.teamOfSession,
      adapters: { fixture, rounds: roundAdaptersUsed },
      promotionTeams: () => integrationStore.promotionTeams(),
      promotions: promotions.runner,
    })
  }
  // Decisions write their cards, decisions, and mail in one transaction, and
  // every committed write announces the plan so its detail is re-pushed (D15).
  const decisionStore = new DecisionStore(options.db)
  const decisions = team ? new DecisionService({
    db: options.db, decisions: decisionStore, plans: options.plans, planService: plans,
    tasks: team.tasks, taskStore: team.taskStore, assignments: team.assignments, mailbox: team.teamMailbox, getSession: options.getSession,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}), onChange: planId => options.plans.announce(planId),
  }) : null
  // Holds (revision-control 3.1): the owner's place, release (whole, by
  // changes, or narrowed with retain), and extend — one transaction with the
  // D3 event, the executor wake after the commit.
  const holds = new HoldService({
    holds: holdStore, plans: options.plans, planService: plans,
    strategies: options.strategies, impact: options.impact.store, decisions: decisionStore,
    executions: executionStore, wake: teamId => runtime?.command(teamId),
  })
  let monitor: SupervisionMonitor | null = null
  if (team?.supervision) {
    // The detail and the monitor's sweeps read one loader with the monitor's own `waitEndedAt` (D11).
    const composed = composeSupervisionMonitor({
      db: options.db, plans: options.plans, executions: executionStore, decisions: decisionStore, mailbox: team.mailbox,
      tasks: team.tasks, taskStore: team.taskStore, assignments: team.assignments, integration: integrationStore, identityOf: team.identityOf,
      reads: {
        db: options.db, mail: team.mailbox, executions: executionStore, plans: options.plans, decisions: decisionStore, integration: integrationStore,
        conditionsOf, runtime: team.supervision, tasks: team.taskStore, impact: (teamId, planId) => options.impact.planImpact(teamId, planId),
      },
      ...(options.monitor ? { monitor: options.monitor } : {}),
    })
    monitor = composed.monitor
    supervisionReads = composed.reads
    // A fix task carries no plan link, so its status changes re-push the plan through its fix row (D15).
    team.taskStore.subscribe(task => {
      const fix = decisionStore.fixTask(task.teamId, task.id)
      if (fix !== null) options.plans.announce(fix.planId)
    })
  }
  return {
    validation, validationStore, plans, validationDetail: new ValidationDetailCache(validation), adapter, executions, executionStore,
    runtime, decisions, holds, monitor, promotions: promotions.service, integrationStore,
    // The workspace's bindings and command ledger over the same database (plan-workspace 1.2).
    workspaceStore: new PlanWorkspaceStore(options.db),
    // The workspace's document references and context snapshots (plan-workspace 1.2).
    workspaceRefs: new PlanWorkspaceRefs(options.db),
    workspaceContext: new PlanWorkspaceContext(options.db),
    // The supervision reads the workspace's plan attention gathers over (plan-supervision D13); null without team services.
    supervisionReads,
    checkpoints,
    pauses: composedPauses,
  }
}

/**
 * The settings Start reads: the user's `~/.kawai/teams.json` through the
 * caps, except under the development fixture, where the deterministic floor
 * map and defaults replace configuration so the walkthrough always starts.
 */
function executionSettings(caps?: { planExecution: (teamId: string) => Promise<PlanExecutionSettings> }): { planExecution: (teamId: string) => Promise<PlanExecutionSettings> } {
  if (chatFixtureEnabled) return { planExecution: async () => ({ floorChecks: FIXTURE_FLOOR, maxParallelChanges: 3, mergeMethod: 'merge' }) }
  return caps ?? { planExecution: async () => ({ floorChecks: null, maxParallelChanges: 3, mergeMethod: 'merge' }) }
}

/**
 * The group-scoping read the release step consults (D11): the team's
 * current group files through its identity (N7); an unknown team counts as
 * scoped.
 */
function groupScopedOf(team: ExecutionTeamServices, teamId: string, groupId: string): boolean {
  const identity = team.identityOf(teamId)
  if (identity === undefined) return true
  return loadGroupCatalog({ groupsRoot: identity.groupsRoot }).groups.get(groupId)?.group.worktreeScoped ?? true
}

/** The team's identity for Kawai's own stop; without team services, a bare one (nothing reads its groups). */
function identityOrBare(team: ExecutionTeamServices | undefined, teamId: string): TeamIdentity {
  return team?.identityOf(teamId) ?? { teamId, groupsRoot: '' }
}
