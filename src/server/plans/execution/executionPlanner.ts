// The pure planner (plan-execution D5 step 2): `planSteps(snapshot, now)`
// returns the transitions and effects one tick owes — nothing here reads a
// store, so the executor stays a thin loop and tests drive scenarios as
// data. Scheduling (D6/D11): a change waits until every change it dependsOn
// in its revision has landed, under the execution's parallel limit, picked
// in content order; a stopped dependency holds its dependents while
// independent work continues; landed work is never redone. A `provisioning`
// change without a standing provision effect gets one (D6); an
// `implementing` change without a task gets its task and first dispatch
// (D7/D8), performed by the executor, not an effect row.
import type { ChangeState, EffectKind } from '../../../shared/planExecution'
import { holdGate } from '../revisionControl/holdGate'
import type { ChangePatch } from './executionStore'
import type { ExecutionSnapshot } from './executionSnapshot'

export interface PlannedTransition {
  executionId: string
  change: string
  guard: { state: ChangeState; generation: number }
  patch: ChangePatch
}

export interface PlannedEffect {
  executionId: string
  /** null for an execution-level effect issued again after a Retry (X3). */
  change: string | null
  kind: EffectKind
  effectKey: string
  command: Record<string, unknown>
}

/** The dispatch step (D7/D8; the owed attempt of a released hold or refused send, revision-control 3.2, PR E A1): performed, never an effect row. */
export interface PlannedDispatch {
  executionId: string
  change: string
  group: string
  kind: 'implement' | 'owed'
}

/** One round-pipeline stage (D9-D11), performed by the executor in order. */
export interface PlannedStage {
  executionId: string
  change: string
  kind: 'result' | 'push' | 'open-pr' | 'ci' | 'review' | 'review-restart' | 'verdict' | 'revision' | 'landing' | 'post-ci' | 'redispatch' | 'landing-outcome'
  roundId: string | null
  resultId: string | null
  /** A `landing-outcome` stage's settled merge or update-branch effect. */
  effectId?: string
}

export interface PlanSteps {
  transitions: PlannedTransition[]
  effects: PlannedEffect[]
  dispatches: PlannedDispatch[]
  stages: PlannedStage[]
  fixes: PlannedFix[]
}

/** D12's fix step after a failed round; the executor applies the count rule. */
export interface PlannedFix {
  executionId: string
  change: string
  roundId: string
}

/** The states that occupy the execution's parallel-limit slots. */
const IN_PROGRESS: ReadonlySet<ChangeState> = new Set(['provisioning', 'implementing', 'gating', 'landing'])

export function planSteps(snapshot: ExecutionSnapshot, _now: string): PlanSteps {
  const steps: PlanSteps = { transitions: [], effects: [], dispatches: [], stages: [], fixes: [] }
  const standing = new Set(snapshot.effects.map(effect => effect.effectKey))
  for (const execution of snapshot.executions) {
    if (execution.finished) {
      // A stopped execution only settles the merge that ran at Stop (D12):
      // landed and accepted if it merged, cancelled with its task otherwise.
      for (const change of execution.changes) {
        const effect = change.landingEffect
        if (change.state === 'landing' && effect !== null && (effect.kind === 'merge' || effect.kind === 'fast-forward') && (effect.state === 'done' || effect.state === 'failed')) {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: effect.id })
        }
      }
      continue
    }
    const states = new Map(execution.changes.map(change => [change.change, change.state]))
    let inProgress = execution.changes.filter(change => IN_PROGRESS.has(change.state)).length
    // An execution-level effect (integration's create-integration, D4) holds
    // every waiting change until it is done; a failed one stopped them, and
    // once Retry returns one to waiting the effect is issued again under the
    // next count, with the same command.
    const setupEffects = execution.setupEffects ?? []
    const setup = setupEffects.at(-1)
    const setupStanding = setup !== undefined && (setup.state === 'pending' || setup.state === 'running' || setup.state === 'unknown')
    if (setup !== undefined && setup.state === 'failed' && execution.changes.some(change => change.state === 'waiting')) {
      const count = setupEffects.filter(effect => effect.kind === setup.kind).length + 1
      const effectKey = `${execution.row.id}::${setup.kind}:${count}`
      if (!standing.has(effectKey)) steps.effects.push({ executionId: execution.row.id, change: null, kind: setup.kind, effectKey, command: setup.command })
    }
    const setupHolds = setupStanding || setup?.state === 'failed'
    for (const change of execution.changes) {
      if (change.state === 'landed') {
        // D13 step 6: base-branch CI on the merge commit is polled until it
        // finishes and lands as the landing fact's evidence. An integration
        // landing is the verified commit itself: no further CI (D5).
        if (change.landing !== null && change.landing.postCi === null && change.landing.mechanism === 'direct') {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'post-ci', roundId: null, resultId: null })
        }
        continue
      }
      if (change.state === 'stopped' || change.state === 'cancelled') continue
      // The hold gate (revision-control 3.2): what a hold closes, the
      // planner withholds — the step onto the worktree, every attempt
      // dispatch, the review handoff, and the owed fix of an interrupted
      // one. What it leaves open still plans: decisions (a round's result,
      // a verdict, the failed round's fix transition), the push, the PR,
      // and CI run for a held change; only its dispatches wait.
      const held = holdGate(execution.holds, execution.openTargets, change.change) !== null
      if (change.state === 'waiting') {
        // A dependency that has not landed holds the change — stopped ones
        // included; independent changes elsewhere in the plan continue.
        const blocked = setupHolds || change.dependsOn.some(dependency => states.get(dependency) !== 'landed')
        if (held || blocked || inProgress >= execution.row.maxParallel) continue
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: { state: 'provisioning' },
        })
        states.set(change.change, 'provisioning')
        inProgress += 1
        continue
      }
      if (change.state === 'provisioning') {
        const attempt = (snapshot.attempts.get(`${change.executionId}:${change.change}`) ?? 0) + 1
        const effectKey = `${change.executionId}:${change.change}:provision:${attempt}:${change.generation}`
        if (standing.has(effectKey) || held) continue
        steps.effects.push({
          executionId: change.executionId, change: change.change, kind: 'provision', effectKey,
          command: {
            repo: snapshot.main,
            path: `${snapshot.main}/.worktrees/${change.change}`,
            branch: change.change,
            base: execution.row.baseCommit,
            baseBranch: execution.row.baseBranch,
            planId: execution.row.planId,
            // The provision starts from this execution's newest landing among these.
            dependsOn: change.dependsOn,
          },
        })
        continue
      }
      // Retry of a failed or closed stage (D12): its instruction is sent
      // again before anything reads the old, failed assignment. A hold
      // withholds the dispatch; the step stays due for the release.
      if (change.step === 'redispatch') {
        if (!held) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'redispatch', roundId: null, resultId: null })
        continue
      }
      // The implement dispatch (H4): only a change without any attempt row —
      // no task, or a task whose dispatch never committed (a refused one,
      // retried). An existing undispatched row belongs to the owed step, and
      // the dispatch's own H4 guard (revision-control PR E, A3) backs this up
      // for every caller.
      if (!held && change.state === 'implementing' && change.group !== null && change.newestAttempt === null
        && (change.taskId === null || (change.task !== null && change.task.assignment === null && change.task.results.length === 0))) {
        steps.dispatches.push({ executionId: change.executionId, change: change.change, group: change.group, kind: 'implement' })
      }
      // The owed dispatch (revision-control 3.2, PR E A1/H1): the newest
      // attempt is still owed — never dispatched (no assignment carries its
      // exact key, no stamp) and no round answers it (H″ O1). Implement and
      // fix rows are owed in `implementing`; an update row is owed in
      // `gating` with no step and no passed round — the failed update
      // returned the change before its dispatch committed. It runs exactly
      // once on the first tick it is reachable, under the attempt's own
      // request key; the row's one writer beside the fixes step (H″ O2).
      if (!held && change.group !== null && change.task !== null && change.newestAttemptOwed
        && (change.newestAttempt?.kind === 'update'
          ? change.state === 'gating' && change.step === null && change.passedAt === null
          : change.state === 'implementing')) {
        steps.dispatches.push({ executionId: change.executionId, change: change.change, group: change.group, kind: 'owed' })
      }
      // D13's follow-ons: a settled merge or update-branch effect of a
      // landing change is applied by the tick (merge → landed, or back to
      // up-to-date; update → the clean-merge check, polled until the head
      // moves); a standing one is left to settle. A change the Retry left
      // waiting for the slot (A2's fallback) is a resumed landing: its
      // re-opened row — any landing kind of the current round — is what
      // decides (I-B), so a settled one is applied and a live or pending one
      // is never re-derived. Checked before a human close (D19): like Stop
      // for that one change, the running effect settles and is recorded
      // first, and a completed merge lands.
      const landingEffect = change.landingEffect
      const roundMatched = landingEffect !== null && change.round !== null && landingEffect.roundId === change.round.id
      const settling = change.state === 'landing' && (change.step === 'merging' || change.step === 'updating')
      const resumedWait = change.state === 'gating' && change.step === 'awaiting-slot' && roundMatched
      if (settling) {
        if (landingEffect !== null && landingEffect.state === 'done'
          && ((change.step === 'merging' && (landingEffect.kind === 'merge' || landingEffect.kind === 'fast-forward')) || (change.step === 'updating' && landingEffect.kind === 'update-branch'))) {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
        }
        if (landingEffect !== null && landingEffect.state === 'failed'
          && (landingEffect.outcome as { stop?: unknown } | null)?.stop !== undefined) {
          // An inspection's stop verdict on a settling change (pr-closed, a
          // foreign branch): the same stop a run's failure would have written.
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
        }
        continue
      }
      if (resumedWait) {
        if (landingEffect !== null && landingEffect.state === 'done') {
          // Any landing verdict: merged, refused (merged:false), a
          // fast-forward's moved or rewritten answer — the follow-on applies
          // what happened, never what a re-derivation would now compute.
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
          continue
        }
        if (landingEffect !== null && landingEffect.state === 'failed'
          && (landingEffect.outcome as { stop?: unknown } | null)?.stop !== undefined) {
          // An inspection's stop verdict (pr-closed, a foreign branch): the
          // change stops through the same path a run's failure would.
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
          continue
        }
        // Live (running, or unknown awaiting its inspection): the row decides
        // first — nothing is planned (I-A). A pending row is queued for the
        // slot: the normal landing stage below waits for the slot and adopts
        // the row (A1) when it re-enters.
        if (landingEffect !== null && (landingEffect.state === 'running' || landingEffect.state === 'unknown')) continue
      }
      // A verdict that settled behind the change's step: a merge that merged
      // (or an update that moved the head) while the stage read up-to-date
      // again is applied instead of re-derived; a refused merge re-runs the
      // stage from the up-to-date step.
      if (change.state === 'landing' && change.step === 'up-to-date' && roundMatched && landingEffect !== null && landingEffect.state === 'done'
        && (landingEffect.kind === 'update-branch'
          || (landingEffect.kind === 'merge' && (landingEffect.outcome as { merged?: unknown } | null)?.merged === true))) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing-outcome', roundId: null, resultId: null, effectId: landingEffect.id })
        continue
      }
      // A human close of the change's task stops it (D19); Kawai's own closes
      // happen after landing, on a change that no longer runs. Checked before
      // the failed instruction: the close itself dead-letters queued task
      // mail (member release), and the close is the cause.
      if (change.task !== null && (change.task.status === 'done' || change.task.status === 'cancelled')) {
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: { state: 'stopped', stopReason: 'task-closed', step: null, stopDetail: { message: `The task was ${change.task.status} by hand.`, resumeState: change.state, ...(change.taskId !== null ? { taskId: change.taskId } : {}) } },
        })
        continue
      }
      // A stage instruction that failed stops the change (D12): its
      // assignment derives failed — the mail settled dead, cancelled, or
      // discarded. Only the current stage can fail it; a superseded
      // assignment derives superseded and never stops anything.
      if (change.task?.assignment?.state === 'failed') {
        steps.transitions.push({
          executionId: change.executionId, change: change.change,
          guard: { state: change.state, generation: change.generation },
          patch: {
            state: 'stopped', stopReason: 'instruction-failed', step: null,
            stopDetail: {
              message: `The stage instruction failed to deliver (${change.task.assignment.reason ?? 'the mail settled'}).`,
              assignmentId: change.task.assignment.id,
              resumeState: change.state,
            },
          },
        })
        continue
      }
      if (change.task === null) continue
      // The round pipeline (D9-D11): a result becomes a round, a round is
      // pushed, PR'd, CI-read, reviewed, and decided. A landing change holds
      // the slot for its base merge, so no newer result supersedes its round;
      // a resumed landing keeps its round until its re-opened row decides.
      const newest = change.task.results.at(-1) ?? null
      if (change.state !== 'landing' && !resumedWait && newest !== null && (change.round === null || change.round.resultId !== newest.id)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'result', roundId: null, resultId: newest.id })
        continue
      }
      const round = change.round
      // D9, narrowed by revision-control PR E (H2): a result pinned to an
      // older task revision can never pass — the change returns for a fix
      // attempt naming the revision (a landing change too, releasing the
      // slot), unless its merge started or an update-branch effect is still
      // settling. The stage fires for an open or passed round only: a failed
      // round's fix is already out and answers that round, so it carries the
      // newest revision through its notice instead, and a superseded round's
      // fix attempt is already out. An owed newest attempt is the change's
      // next instruction and the owed step is its one writer (H″ O2): the
      // gate holds the revision fix until the row is out — superseding its
      // round before the dispatch committed would orphan the attempt; the
      // next failed update, or this stage once the row is out, re-mints.
      if (round !== null && !change.newestAttemptOwed && (round.outcome === null || round.outcome === 'pass') && change.task.results.some(result => result.id === round.resultId && result.taskRevision < change.task!.revision)) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'revision', roundId: round.id, resultId: null })
        continue
      }
      if ((change.state !== 'gating' && change.state !== 'landing') || round === null) continue
      if (round.outcome === 'pass' && change.passedAt !== null) {
        // D13: a passed change lands — conditions first, then the slot, then
        // up to date and the merge.
        // revision-control 3.3: a held change that holds the slot with no
        // live landing-kind effect gives the slot up in one guarded
        // transition and returns to its pre-slot step (`gating`, passed
        // round kept), so another change can land. A pending, running, or
        // unknown effect settles first — a merging or updating change left
        // above — and the hold applies from the next step.
        if (held && change.state === 'landing') {
          const landingLive = change.landingEffect !== null
            && ['pending', 'running', 'unknown'].includes(change.landingEffect.state)
          if (!landingLive) {
            steps.transitions.push({
              executionId: change.executionId, change: change.change,
              guard: { state: change.state, generation: change.generation },
              patch: { state: 'gating', step: null },
            })
          }
          continue
        }
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'landing', roundId: round.id, resultId: null })
        continue
      }
      if (round.outcome === 'fail') {
        // A failed round returns the change for fixes under the count rule
        // (D12) — a carried round that failed base-merge CI too, leaving the
        // slot; the executor decides stop versus dispatch. The fixes step is
        // applyFix's own row's one writer (H″ O2): the dispatch runs before
        // the transition, so a refused or interrupted send leaves the change
        // gating on the failed round and this step re-runs it — after Retry,
        // or on the next pass — re-sending the same key: a refused send
        // wrote nothing, and a committed one replays by key and payload. The
        // owed step never fires there: 'gating' is not a fix row's owed state.
        steps.fixes.push({ executionId: change.executionId, change: change.change, roundId: round.id })
        continue
      }
      if (round.outcome !== null) continue
      // A round's effects are found by the round, never by a key that
      // carries the generation: any transition bumps it, and a round must
      // not lose its push, its PR, or its one rerun to a bump (D10, D14).
      const ofRound = (kind: string) => change.roundEffects.filter(effect => effect.kind === kind).at(-1) ?? null
      const live = (effect: { state: string } | null) => effect !== null && (effect.state === 'pending' || effect.state === 'running' || effect.state === 'unknown')
      const ciStage = () => {
        if (!live(ofRound('rerun'))) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'ci', roundId: round.id, resultId: null })
      }
      if (round.carriedFrom !== null) {
        // A carried round keeps its review: CI on the new head decides it.
        ciStage()
        continue
      }
      if (round.pushedAt === null) {
        if (!live(ofRound('push'))) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'push', roundId: round.id, resultId: null })
        continue
      }
      // The change's one pull request: each round re-lists once (reusing an
      // open one, stopping on a closed one — plan-landing); CI and the review
      // wait for it, so no review is dispatched for a round without its PR.
      if (change.branch !== null) {
        const pull = ofRound('open-pr')
        if (pull === null || pull.state === 'failed' || pull.state === 'cancelled') {
          steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'open-pr', roundId: round.id, resultId: null })
          continue
        }
        if (live(pull)) continue
      }
      // A held restart's owed review handoff (revision-control 4.5 LC1): the
      // change's step marks the debt, the round's pointer is already clear —
      // so this routes to the restart stage, never to a verdict that would
      // wait on the superseded handoff. The stage dispatches the one fresh
      // handoff and returns the step to `reviewing`; until then it re-plans.
      // A standing hold keeps the debt owed: like every dispatch stage, it
      // waits for the gate (the release routes it here).
      if (change.step === 'review-restart') {
        if (!held) steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'review-restart', roundId: round.id, resultId: null })
      } else if (round.reviewAssignmentId !== null) {
        steps.stages.push({ executionId: change.executionId, change: change.change, kind: 'verdict', roundId: round.id, resultId: null })
      } else {
        ciStage()
      }
    }
  }
  return steps
}
