// The Results section of task detail (task-results-handoffs 7.1/7.2, design
// D5/D8): the outstanding result first, superseded ones readable beneath.
// **Accept result** opens a confirmation showing the task's acceptance
// criteria and its open child tasks, and asks for a stated reason when the
// result needs re-evaluation or children are open (the server enforces the
// same). **Request review**, **Request QA**, and **Return for fixes** act on
// the outstanding result through a role request whose key is armed per
// payload. Inputs survive a refusal; every control disables while
// disconnected. A task a running execution owns has no **Accept result**:
// Kawai accepts it when the change lands, and a human accept would stop it.
import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import type { HumanTaskDetail, TaskHandoffKind, TaskResult } from '@shared/teamTasks'
import { TASK_HANDOFF_KINDS } from '@shared/teamTasks'
import type { TaskActFn } from './TaskDirectionEditor'
import TaskResultCard from './TaskResultCard'
import { HANDOFF_ACTIONS, HANDOFF_ROLE_HINT, RoleRequestFields, emptyRoleRequest, requestPayload, requestReady, workerField, type RoleRequest, type WorkerPickerHost } from './TaskHandoffForm'
import type { TeamGroupOption } from '../chat/useTeamGroups'

export default function TaskResultsSection({ detail, groups, sessions, connected, disabled, act, host }: {
  detail: HumanTaskDetail
  /** Where the handoff form's worker picker reads capacity. */
  host: WorkerPickerHost
  groups: TeamGroupOption[]
  sessions: Session[]
  connected: boolean
  /** Disconnected, or an action awaits its result. */
  disabled: boolean
  act: TaskActFn
}) {
  const task = detail.task
  const results = detail.results ?? []
  const [accepting, setAccepting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  /** The open handoff form, with the outstanding assignment it opened over (so a landing is a new one). */
  const [handoff, setHandoff] = useState<{ kind: TaskHandoffKind; request: RoleRequest; openedOver: string | null } | null>(null)
  const openChildren = detail.subtasks.filter(child => child.status !== 'done' && child.status !== 'cancelled')
  // The handoff landed: a new outstanding assignment of its kind appeared, so the form closes.
  const assignment = task.assignment
  const landed = handoff && assignment && assignment.id !== handoff.openedOver && assignment.handoffKind === handoff.kind ? assignment.id : null
  useEffect(() => { if (landed) setHandoff(null) }, [landed])
  const roleFor = (kind: TaskHandoffKind) => groups.some(group => group.id === HANDOFF_ROLE_HINT[kind]) ? HANDOFF_ROLE_HINT[kind] : ''

  const ownedByExecution = detail.executionOwned === true
  const acceptConfirm = (result: TaskResult) => {
    const needsReason = result.needsReevaluation || openChildren.length > 0
    return <div className="mt-2 border border-border p-2" data-testid="task-accept-confirm">
      <p className="font-medium">Accept this result and close the task as done?</p>
      <p className="text-chat-meta text-secondary">Acceptance criteria</p>
      <p className="whitespace-pre-wrap text-chat-body" data-testid="accept-criteria">{task.acceptance ?? 'No acceptance criteria were set.'}</p>
      {openChildren.length > 0 && <div className="text-chat-meta" data-testid="accept-open-children">
        <p>Open child tasks — a parent never closes them:</p>
        {openChildren.map(child => <p key={child.id}>· {child.title} ({child.status})</p>)}
      </div>}
      {result.needsReevaluation && <p className="text-chat-meta text-chat-danger">This result was submitted at revision {result.taskRevision}; the task is at revision {task.revision}.</p>}
      {needsReason && <input className="input mt-1 text-chat-body" aria-label="Acceptance reason" placeholder="Reason (required)"
        value={reason} disabled={!connected} onChange={event => setReason(event.target.value)} />}
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-primary" data-testid="task-accept-confirm-button" disabled={disabled || (needsReason && !reason.trim())}
          onClick={() => act('accept', { type: 'team-task-accept-result', resultId: result.id, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>
          Accept result</button>
        <button type="button" className="btn" onClick={() => { setAccepting(null); setReason('') }}>Cancel</button>
      </div>
    </div>
  }

  const handoffForm = (result: TaskResult, kind: TaskHandoffKind, request: RoleRequest) => <div className="mt-2 border border-border p-2" data-testid="task-handoff-form" data-kind={kind}>
    <p className="font-medium">{HANDOFF_ACTIONS[kind]} — result {result.id}</p>
    <RoleRequestFields value={request} onChange={next => setHandoff(current => (current ? { ...current, request: next } : current))} groups={groups} disabled={!connected} label={HANDOFF_ACTIONS[kind]} host={host} connected={connected} />
    <div className="mt-2 flex gap-2">
      <button type="button" className="btn btn-primary" data-testid="task-handoff-send" disabled={disabled || !requestReady(request)}
        onClick={() => act('handoff', {
          type: 'team-task-handoff', kind, resultId: result.id, target: { kind: 'group', id: request.target },
          instructions: request.instructions.trim(), ...(request.expectedResponse.trim() ? { expectedResponse: request.expectedResponse.trim() } : {}),
          ...workerField(request),
        }, { slot: `handoff:${task.id}:${kind}`, payload: requestPayload(kind, result.id, request) })}>Send {HANDOFF_ACTIONS[kind].toLowerCase()}</button>
      <button type="button" className="btn" onClick={() => setHandoff(null)}>Close</button>
    </div>
  </div>

  return <div data-testid="task-results">
    <h5 className="font-medium">Results</h5>
    {results.length === 0 && <p className="text-chat-meta text-secondary">No result submitted yet</p>}
    {ownedByExecution && <p className="text-chat-meta text-secondary" data-testid="task-execution-owned-note">
      A running execution owns this change: Kawai accepts this task when the change lands. To stop the change, use the Plans view.
    </p>}
    {results.map(result => <TaskResultCard key={result.id} result={result} sessions={sessions}>
      <div className="mt-2 flex flex-wrap gap-2">
        {!ownedByExecution && <button type="button" className="btn text-chat-meta" data-testid="task-accept" disabled={disabled || result.acceptedAt !== null}
          title={!connected ? 'Reconnect to accept' : result.acceptedAt !== null ? 'Already accepted' : undefined}
          onClick={() => { setAccepting(result.id); setReason('') }}>Accept result</button>}
        {/* Recheck (independent-verification D4): asks Kawai to check again; idempotent
            while a check is pending, so no request key is armed. */}
        <button type="button" className="btn text-chat-meta" data-testid="task-recheck" disabled={disabled}
          title={!connected ? 'Reconnect to recheck' : undefined}
          onClick={() => act('recheck', { type: 'team-task-recheck', resultId: result.id })}>Recheck</button>
        {result.supersededBy === null && TASK_HANDOFF_KINDS.map(kind => <button key={kind} type="button" className="btn text-chat-meta"
          data-testid={`task-handoff-${kind}`} disabled={disabled}
          onClick={() => setHandoff(current => current?.kind === kind ? current
            : { kind, request: emptyRoleRequest(roleFor(kind)), openedOver: task.assignment?.id ?? null })}>{HANDOFF_ACTIONS[kind]}</button>)}
      </div>
      {!ownedByExecution && accepting === result.id && result.acceptedAt === null && acceptConfirm(result)}
      {result.supersededBy === null && handoff && handoffForm(result, handoff.kind, handoff.request)}
    </TaskResultCard>)}
  </div>
}
