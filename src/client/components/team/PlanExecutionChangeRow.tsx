// One change's row in the Execution section (plan-execution D17): state and
// waiting reason, task, PR, fix-round count, the latest round's CI with its
// flaky marks, the verdict, each extra check labeled verified by CI or
// attested by the reviewer, the landing fact flagged when its tree was not
// verified (and marked promoted once a merged promotion carried it into the
// target), and the change's effects, expandable. Its id is where a `plan`
// attention link with that change scrolls to and focuses (plan-supervision
// D15). A stopped change of a running execution offers the owner's Retry
// (plan-execution D12).
import { useEffect, useRef, useState } from 'react'
import type { SendClientMessage } from '@shared/types'
import type { ExecutionChangeView, PlanExecutionView } from '@shared/planExecution'
import { CHANGE_STATE_LABELS, CHANGE_STEP_LABELS } from '@shared/planExecutionProgress'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import PlanCommandDialog, { sendPlanCommand } from './PlanCommandDialog'

const waitingLabel = (row: ExecutionChangeView): string | null => {
  const waiting = row.waiting
  if (waiting === null) return null
  switch (waiting.kind) {
    case 'dependency': return `waiting for ${waiting.changes.join(', ')}`
    case 'parallel-limit': return `waiting for a slot (limit ${waiting.limit})`
    case 'effect': return `${waiting.effect} ${waiting.state}`
    case 'ci': return `CI running: ${waiting.pending.join(', ')}`
    case 'release': return `releasing the worktree (${waiting.reason})`
    case 'review': return 'awaiting review'
    case 'slot': return `holding the landing slot${waiting.holder !== null ? ` (${waiting.holder})` : ''}`
    case 'merge': return 'merging'
    case 'instruction': return `instruction ${waiting.state}`
    case 'conditions': return `conditions: ${waiting.conditions.join(', ')}`
  }
}

export default function PlanExecutionChangeRow({ teamPath, connected, onSend, row, execution, promoted = false, onOpenTask, revealed = false }: {
  teamPath: string
  connected: boolean
  onSend: SendClientMessage
  row: ExecutionChangeView
  execution: PlanExecutionView
  /** A merged promotion carried this change's landing into the target (D11). */
  promoted?: boolean
  onOpenTask: (taskId: string) => void
  /** The attention link named this change: scroll into view and take focus (plan-supervision D15). */
  revealed?: boolean
}) {
  const [effectsOpen, setEffectsOpen] = useState(false)
  const rowRef = useRef<HTMLLIElement | null>(null)
  const retryBusy = useTeamPlanStore(state => Object.values(state.views[teamPath]?.pending ?? {}).includes('retry'))
  useEffect(() => {
    if (!revealed) return
    rowRef.current?.scrollIntoView({ block: 'center' })
    rowRef.current?.focus()
  }, [revealed])
  const waiting = waitingLabel(row)
  const round = row.latestRound
  const retrySlot = `retry:${execution.id}:${row.change}:${row.generation}`
  return <li ref={rowRef} id={`plan-change-${row.change}`} tabIndex={-1} className="border border-border p-2" data-testid="plan-execution-change">
    <p className="text-chat-body">
      <span className="font-medium">{row.change}</span>
      {' · '}{CHANGE_STATE_LABELS[row.state]}
      {row.step !== null ? ` (${CHANGE_STEP_LABELS[row.step]})` : ''}
      {row.fixRounds > 0 ? ` · fix rounds ${row.fixRounds}/3` : ''}
      {row.stopReason !== null ? ` · stopped: ${row.stopReason}` : ''}
    </p>
    {waiting !== null && <p className="text-chat-meta text-secondary" data-testid="plan-execution-waiting">{waiting}</p>}
    <p className="text-chat-meta">
      {row.taskId !== null
        ? <button type="button" className="link" onClick={() => onOpenTask(row.taskId!)}>task {row.taskId.slice(0, 8)}</button>
        : 'no task yet'}
      {row.prUrl !== null && <> · <a className="link" href={row.prUrl} target="_blank" rel="noreferrer">pull request #{row.prNumber}</a></>}
      {row.branch !== null && ` · ${row.branch}`}
    </p>
    {round !== null && <p className="text-chat-meta" data-testid="plan-execution-round">
      round {round.number}
      {round.ci !== null && ` · CI: ${round.ci.checks.map(check => `${check.name}${round.ci!.flaky.includes(check.name) ? ' (flaky)' : ''}=${check.conclusion}`).join(', ')}`}
      {round.verdict !== null && ` · review ${round.verdict.verdict}`}
      {round.outcome !== null && ` · ${round.outcome}`}
    </p>}
    {round !== null && round.extraChecks.length > 0 && <ul className="text-chat-meta" data-testid="plan-execution-extra-checks">
      {round.extraChecks.map(check => <li key={check.name} title={check.description}>
        {`${check.name} · ${check.by === 'ci' ? 'verified by CI' : `attested by the reviewer${round.verdict !== null ? ` (${round.verdict.reviewer})` : ''}`}`}
      </li>)}
    </ul>}
    {row.landing !== null && <p className="text-chat-meta" data-testid="plan-execution-landing">
      landed{row.landing.treeVerified ? '' : ' — tree not verified, base moved at the last moment'}
      {promoted && <span data-testid="plan-execution-promoted">{' · promoted'}</span>}
      {row.landing.postCi !== null && row.landing.postCi.length > 0 ? ` · base CI: ${row.landing.postCi.map(check => `${check.name}=${check.conclusion}`).join(', ')}` : ''}
    </p>}
    {row.effects.length > 0 && <div className="mt-1">
      <button type="button" className="link text-chat-meta" onClick={() => setEffectsOpen(!effectsOpen)} aria-expanded={effectsOpen}>
        {effectsOpen ? 'Hide effects' : `Effects (${row.effects.length})`}
      </button>
      {effectsOpen && <ul className="text-chat-meta" data-testid="plan-execution-effects">
        {row.effects.map(effect => <li key={effect.id}>{effect.kind} · {effect.state}{effect.error !== null ? ` · ${effect.error}` : ''}</li>)}
      </ul>}
    </div>}
    {execution.state === 'running' && row.state === 'stopped' && <div className="mt-1" data-testid="plan-execution-retry">
      <PlanCommandDialog teamPath={teamPath} slot={retrySlot} openLabel="Retry…" confirmLabel="Retry"
        testId="plan-execution-retry-command" connected={connected} busy={retryBusy}
        onConfirm={() => sendPlanCommand(teamPath, onSend, 'retry', retrySlot,
          { executionId: execution.id, change: row.change },
          ids => ({ type: 'team-plan-execution-retry', teamPath, executionId: execution.id, change: row.change, ...ids }))}>
        <p className="text-chat-meta">Retry re-runs this stage of {row.change}. If its task is closed, reopen the task first.</p>
      </PlanCommandDialog>
    </div>}
  </li>
}
