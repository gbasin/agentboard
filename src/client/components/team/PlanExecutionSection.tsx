// The Execution section of a plan's detail (plan-execution D17, §15.4): the
// newest execution's header (state, outcome, base, stop reason) with one row
// per change — each change's decision cards render inline directly beneath
// its row (plan-supervision D15) — Start (fetching the server's standing)
// when nothing runs, and Stop while something does; a landed change carried
// into the target by a merged promotion is marked promoted, and an
// integration plan's branches follow (`PlanIntegrationPanel`). Every control
// disables while disconnected.
import { Fragment } from 'react'
import type { SendClientMessage, Session } from '@shared/types'
import type { PlanDetail, PlanSummary } from '@shared/plans'
import { promotedChanges } from '@shared/planIntegration'
import PlanIntegrationPanel from './PlanIntegrationPanel'
import PlanExecutionChangeRow from './PlanExecutionChangeRow'
import PlanExecutionStartDialog from './PlanExecutionStartDialog'
import PlanExecutionStopDialog from './PlanExecutionStopDialog'
import PlanDecisionCard from './PlanDecisionCard'

export default function PlanExecutionSection({ teamPath, plan, detail, connected, onSend, onOpenTask, sessions = [], busy = false, revealAnchor = null }: {
  teamPath: string
  plan: PlanSummary
  detail: PlanDetail
  connected: boolean
  onSend: SendClientMessage
  onOpenTask?: (taskId: string) => void
  sessions?: Session[]
  busy?: boolean
  /** The attention link's scroll target, when it names this detail's change or card (plan-supervision D15). */
  revealAnchor?: string | null
}) {
  const executions = detail.executions ?? []
  const newest = executions[0] ?? null
  const running = newest !== null && newest.state === 'running'
  const integration = detail.integration ?? []
  const promoted = promotedChanges(integration)
  const decisions = detail.decisions ?? []
  const openTask = onOpenTask ?? (() => undefined)
  const approved = plan.currentApprovedRevision === null
    ? null
    : detail.revisions.find(row => row.revision === plan.currentApprovedRevision) ?? null

  return <section className="mt-3" data-testid="plan-execution-section">
    <h3 className="text-chat-meta font-medium">Execution</h3>
    {newest === null
      ? <div>
        <p className="text-chat-meta text-secondary">No execution has run.</p>
        {approved === null
          ? <p className="text-chat-meta text-secondary">Start needs an approved revision.</p>
          : <div>
            <p className="text-chat-meta text-secondary">Start runs the approved revision from its validated artifacts.</p>
            <PlanExecutionStartDialog teamPath={teamPath} planId={plan.id} revision={approved.revision} contentHash={approved.contentHash} connected={connected} onSend={onSend} />
          </div>}
      </div>
      : <div>
        <p className="text-chat-meta" data-testid="plan-execution-state">
          {running ? 'Running' : `Finished ${newest.outcome ?? ''}`}
          {' · revision '}{newest.revision}
          {newest.outcome === 'stopped' && newest.stopReason !== null ? ` · stopped: ${newest.stopReason}` : ''}
        </p>
        <ul className="mt-1">
          {newest.changes.map(row => <Fragment key={row.change}>
            <PlanExecutionChangeRow row={row} execution={newest} promoted={promoted.has(row.change)} onOpenTask={openTask}
              revealed={revealAnchor === `plan-change-${row.change}`} />
            {decisions.filter(entry => entry.card.change === row.change).map(cardView =>
              <PlanDecisionCard key={cardView.card.id} teamPath={teamPath} planId={plan.id} cardView={cardView} sessions={sessions}
                connected={connected} busy={busy} onSend={onSend} onOpenTask={openTask}
                revealed={revealAnchor === `decision-card-${cardView.card.id}`} />)}
          </Fragment>)}
        </ul>
        {running && <div className="mt-2"><PlanExecutionStopDialog teamPath={teamPath} execution={newest} connected={connected} onSend={onSend} /></div>}
        {!running && approved !== null && <div className="mt-2" data-testid="plan-execution-restart">
          <p className="text-chat-meta text-secondary">Start runs the approved revision again; changes an earlier execution of this plan provisioned keep their worktrees and branches.</p>
          <PlanExecutionStartDialog teamPath={teamPath} planId={plan.id} revision={approved.revision} contentHash={approved.contentHash} connected={connected} onSend={onSend} />
        </div>}
      </div>}
    <PlanIntegrationPanel teamPath={teamPath} planId={plan.id} views={integration} executionRunning={running} connected={connected} onSend={onSend} />
  </section>
}
