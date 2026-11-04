// Shared pieces of the assignment UI (task-assignment 5.2/5.4): the
// group-or-session target chooser and the dispatch preview rendering. Both
// the create form and the task detail's Assign / send task use them, so the
// two stay worded and behaved the same. The preview names a group target's
// worker choice and its models (dispatch-worker-choice 4.2).
import type { Session } from '@shared/types'
import type { TaskDispatchPreview } from '@shared/teamTasks'
import { spawnApprovalSourceLabel } from '@shared/spawnApproval'
import type { TeamGroupOption } from '../chat/useTeamGroups'
import { sessionLabel } from './teamTaskLabels'

export type AssignTargetKind = '' | 'group' | 'session'

export function TaskTargetSelect({ kind, id, onKind, onId, groups, sessions, disabled, testId }: {
  kind: AssignTargetKind
  id: string
  onKind: (kind: AssignTargetKind) => void
  onId: (id: string) => void
  groups: TeamGroupOption[]
  sessions: Session[]
  disabled?: boolean
  testId: string
}) {
  return <div className="flex gap-2" data-testid={testId}>
    <select className="input text-chat-body" aria-label="Assignment target kind" value={kind}
      disabled={disabled} onChange={event => { onKind(event.target.value as AssignTargetKind); onId('') }}>
      <option value="">No assignment</option>
      <option value="group">Group</option>
      <option value="session">Session</option>
    </select>
    {kind === 'group' && <select className="input flex-1 text-chat-body" aria-label="Assignment group" value={id}
      disabled={disabled} onChange={event => onId(event.target.value)} data-testid={`${testId}-group`}>
      <option value="">Choose a group…</option>
      {groups.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}
    </select>}
    {kind === 'session' && <select className="input flex-1 text-chat-body" aria-label="Assignment session" value={id}
      disabled={disabled} onChange={event => onId(event.target.value)} data-testid={`${testId}-session`}>
      <option value="">Choose a session…</option>
      {sessions.map(session => <option key={session.id} value={session.id}>{sessionLabel(session.id, sessions)}</option>)}
    </select>}
  </div>
}

export function TaskPreviewView({ preview }: { preview: TaskDispatchPreview }) {
  const staffing = preview.spawn.allowed
    ? `staffing can add a member${preview.spawn.profile ? ` on ${preview.spawn.profile}` : ''}`
    : `staffing cannot add a member (${preview.spawn.blockedBy ?? 'unknown reason'})`
  return <div className="border border-border p-2 text-chat-meta" data-testid="task-assign-preview">
    <p>{preview.target.kind === 'group' ? `Role: ${preview.role ?? preview.target.id} (group)` : `Session: ${preview.target.id}`}</p>
    <p>Worktree: {preview.worktree ?? 'none'}</p>
    {preview.sessionWorktree && <p>Session worktree: {preview.sessionWorktree}</p>}
    {preview.worker && <p data-testid="task-preview-worker">
      Worker: {preview.worker.selector} ({preview.worker.profiles.join(', ') || 'no model of the group'})
      {preview.worker.cooldownUntil ? ` · cooling until ${new Date(preview.worker.cooldownUntil).toLocaleString()}` : ''}</p>}
    <p>Effective profile: {preview.profile ?? 'none available'}</p>
    <p data-testid="task-preview-approval">Approval: {preview.approval}{preview.approvalSource ? ` · ${spawnApprovalSourceLabel(preview.approvalSource)}` : ''}</p>
    {preview.target.kind === 'group' && <p data-testid="task-preview-idle">
      Idle matching members: {preview.idleMembers.length > 0 ? preview.idleMembers.join(', ') : 'none'}</p>}
    {preview.target.kind === 'group' && <p data-testid="task-preview-staffing">{staffing}</p>}
    {preview.warning && <p className="text-chat-danger" role="warning">{preview.warning}</p>}
  </div>
}
