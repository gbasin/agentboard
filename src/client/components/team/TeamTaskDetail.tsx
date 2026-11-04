// One task in full (team-tasks 7.2, task-assignment 5.4): current direction
// and acceptance with the revision history behind it, the append-only
// journal, subtasks, and the task's messages, plus the human's controls —
// a direction draft published as a new revision (TaskDirectionEditor), the
// results with acceptance and handoffs (TaskResultsSection), release-and-
// hand-off (TaskReleaseDialog), the publication detail per revision
// (TaskPublications), add a note, and set any status including reopening. The human may do all of this whoever created the task, even a
// killed agent. Controls disable while disconnected.
// Assignment (task-assignment): the outstanding assignment with its target,
// role, state, and claimed agent, the assignment history, and **Assign /
// send task** — dispatching over an outstanding assignment first makes the
// human choose **notify** or **stop** (the dialog shows what stands).
// Its Messages section (team-message-threads D7) is the same rows the
// Messages view draws — named participants, killed ones marked `(gone)` —
// with a link into that message's thread. Task *participants* below keep the
// older label, per the design's directory scope note.
import { useEffect, useState } from 'react'
import type { Session, SendClientMessage } from '@shared/types'
import { TASK_STATUSES, type TaskStatus } from '@shared/teamTasks'
import { useTeamTaskStore, type TaskAction, type TaskView } from '../../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import MessageRow from './MessageRow'
import { TaskPreviewView, TaskTargetSelect, type AssignTargetKind } from './taskAssignFields'
import { useTeamGroups } from '../chat/useTeamGroups'
import { assignmentLabel } from './assignmentLabel'
import { actorLabel, journalAuthorLabel, sessionLabel } from './teamTaskLabels'
import TaskDirectionEditor, { type TaskActFn } from './TaskDirectionEditor'
import TaskPublications from './TaskPublications'
import TaskResultsSection from './TaskResultsSection'
import TaskReleaseDialog from './TaskReleaseDialog'
import { TaskWorkerPicker } from './TaskWorkerPicker'

interface DetailAssignForm {
  kind: AssignTargetKind
  id: string
  /** A group target's worker choice; '' = any worker. */
  worker: string
  instruction: string
  /** Armed when the first dispatch is sent; reused by every retry of it. */
  requestKey: string | null
  /** The payload the key was armed for; an edit re-keys the retry. */
  sent?: string
  preview: boolean
}

const emptyAssignForm = (): DetailAssignForm => ({ kind: '', id: '', worker: '', instruction: '', requestKey: null, preview: false })

/** The section that starts collapsed once a team's Tasks tab first opens. */
const DEFAULT_COLLAPSED = ['Revision history']
/** Marks that the default collapsed set was applied, so it is never re-seeded. */
const DEFAULTS_APPLIED = '#defaults'

/**
 * A detail section that collapses on its own, keyed by name in the team's
 * kept view state so a collapsed section stays collapsed across tasks (5.5).
 */
function Section({ teamPath, name, children }: { teamPath: string; name: string; children: React.ReactNode }) {

  const collapsed = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.tasks.collapsedSections.includes(name)) ?? false
  return <section aria-label={name} className="mt-3" data-testid="task-detail-section" data-section={name}>
    <button type="button" className="font-medium" data-testid={`task-section-toggle-${name}`}
      aria-expanded={!collapsed} onClick={() => useTeamWorkspaceStore.getState().toggleSectionCollapsed(teamPath, 'tasks', name)}>
      {collapsed ? `▸ ${name}` : `▾ ${name}`}
    </button>
    {!collapsed && children}
  </section>
}

export default function TeamTaskDetail({ teamPath, projectPath, view, sendMessage, connected, sessions, onBack, onNavigate, onOpenThread, onOpenSession, onOpenMailbox }: {
  teamPath: string; projectPath: string; view: TaskView; sendMessage: SendClientMessage; connected: boolean; sessions: Session[]
  /** Leave the detail for the list; the Team page also clears its URL. */
  onBack?: () => void
  /** Selection moves the host reports (the Team page's URL); internal by default. */
  onNavigate?: (taskId: string | null) => void
  /** Open this message's thread in the Messages view; omitted = no link. */
  onOpenThread?: (threadId: string) => void
  /** Open a message participant's chat; omitted = names only. */
  onOpenSession?: (sessionId: string) => void
  /** Open the team mailbox (an uncertain revision notice is resolved there). */
  onOpenMailbox?: () => void
}) {
  const detail = view.detail
  const task = detail?.task
  const { groups } = useTeamGroups(connected, projectPath)
  const [note, setNote] = useState('')
  const [form, setForm] = useState<DetailAssignForm>(emptyAssignForm)
  const [choice, setChoice] = useState<'notify' | 'stop'>('notify')
  const [choosing, setChoosing] = useState(false)
  // Seed the default collapsed sections once per team (the marker stays, so
  // later opens never re-collapse a section the user expanded).
  const collapsedSections = useTeamWorkspaceStore(state => state.views[teamPath]?.tabs.tasks.collapsedSections) ?? []
  useEffect(() => {
    if (!collapsedSections.includes(DEFAULTS_APPLIED)) {
      useTeamWorkspaceStore.getState().setCollapsedSections(teamPath, 'tasks', [...new Set([...collapsedSections, DEFAULTS_APPLIED, ...DEFAULT_COLLAPSED])])
    }
  }, [teamPath, collapsedSections]) // eslint-disable-line react-hooks/exhaustive-deps
  // Every selection move goes through one place so the URL follows it.
  const go = (taskId: string | null) => {
    useTeamTaskStore.getState().select(teamPath, taskId)
    onNavigate?.(taskId)
  }
  const back = () => { if (onBack) onBack(); else go(null) }
  if (!detail || !task) {
    return <div><button className="btn mb-3" onClick={back}>All tasks</button><p role="status">Loading task…</p></div>
  }
  const disabled = !connected || Object.keys(view.pending).length > 0
  const act: TaskActFn = (action: TaskAction, message, command) => {
    const requestId = crypto.randomUUID()
    const store = useTeamTaskStore.getState()
    // Publish and notify carry the armed command key (task-revision-publication D2/D4).
    const requestKey = command ? store.command(teamPath, command.slot, command.payload, requestId) : undefined
    store.begin(teamPath, requestId, action)
    sendMessage({ teamPath, requestId, taskId: task.id, ...message, ...(requestKey ? { requestKey } : {}) } as Parameters<SendClientMessage>[0])
  }
  const closed = task.status === 'done' || task.status === 'cancelled'
  const statusLabel = (status: TaskStatus) => (status === 'open' && closed ? 'Reopen' : `Mark ${status}`)
  const outstanding = task.assignment
  const outstandingLabel = (row: NonNullable<typeof outstanding>) =>
    `${row.targetKind === 'group' ? `group ${row.targetId}` : sessionLabel(row.targetId, sessions)} · ${row.state}` +
    (row.claimedBy ? ` · claimed by ${sessionLabel(row.claimedBy, sessions)}` : '')

  // The worker choice applies to a group target only (I3).
  const groupWorker = form.kind === 'group' ? form.worker : ''
  const previewAssign = () => {
    const requestId = crypto.randomUUID()
    useTeamTaskStore.getState().beginPreview(teamPath, requestId)
    setForm(current => ({ ...current, preview: true }))
    sendMessage({
      type: 'team-task-preview', teamPath, requestId, taskId: task.id,
      target: { kind: form.kind as 'group' | 'session', id: form.id },
      ...(groupWorker ? { worker: groupWorker } : {}),
    })
  }
  /** Dispatch: over an outstanding assignment the choice is explicit (D7). */
  const sendAssign = (handling?: 'notify' | 'stop') => {
    if (form.kind === '' || !form.id) return
    const payload = JSON.stringify([form.kind, form.id, groupWorker, form.instruction])
    // Reuse the key while the form still asks for the same dispatch; an edit
    // is a new intent (the refused one wrote nothing, so re-keying is safe).
    const requestKey = form.requestKey && form.sent === payload ? form.requestKey : crypto.randomUUID()
    setForm(current => ({ ...current, requestKey, sent: payload }))
    act('assign', {
      type: 'team-task-assign', requestKey,
      target: { kind: form.kind, id: form.id }, instruction: form.instruction,
      ...(handling ? { handling } : {}), ...(groupWorker ? { worker: groupWorker } : {}),
    })
  }
  const assignDisabled = !connected || disabled || form.kind === '' || !form.id || !form.instruction.trim()

  return <div data-testid="task-detail" data-task-id={task.id}>
    <button className="btn mb-3" onClick={back}>All tasks</button>
    <h4 className="font-medium">{task.title}</h4>
    <p className="text-chat-meta text-secondary"><span data-testid="task-detail-status">{task.status}</span> · revision {task.revision} · created by <span data-testid="task-creator">{actorLabel(task.creator, sessions)}</span></p>
    {task.parentId && <p className="text-chat-meta">Subtask of <button className="hover:underline" onClick={() => go(task.parentId!)}>
      {view.tasks.find(row => row.id === task.parentId)?.title ?? task.parentId}</button></p>}
    {task.worktree && <p className="break-all text-chat-meta">Worktree: {task.worktree}</p>}
    {task.openspecChange && <p className="text-chat-meta">Linked OpenSpec change <code>{task.openspecChange}</code> — its proposal, design, and tasks are the authoritative direction.</p>}

    <Section teamPath={teamPath} name="Assignment">
      <div data-testid="task-assignment-section" className="mt-1">
      {outstanding
        ? <p className="text-chat-meta" data-testid="task-outstanding-assignment">
            Outstanding: {outstandingLabel(outstanding)} · role {outstanding.role ?? 'none'}
          </p>
        : <p className="text-chat-meta text-secondary" data-testid="task-outstanding-assignment">Unassigned</p>}
      {!choosing ? <>
        <div className="mt-2 flex flex-col gap-2" data-testid="task-assign-form">
          <TaskTargetSelect testId="task-detail-target" kind={form.kind} id={form.id}
            onKind={kind => setForm(current => ({ ...current, kind, id: '', worker: '' }))} onId={id => setForm(current => ({ ...current, id, worker: '' }))}
            groups={groups} sessions={sessions.filter(session => session.kind === 'chat')} disabled={!connected} />
          {form.kind === 'group' && <TaskWorkerPicker testId="task-detail-worker" teamPath={teamPath} group={form.id} value={form.worker}
            onChange={worker => setForm(current => ({ ...current, worker }))} sendMessage={sendMessage} connected={connected} disabled={!connected} label="Assignment" />}
          <textarea className="input min-h-12 text-chat-body" aria-label="Assignment instruction" placeholder="Instruction"
            value={form.instruction} disabled={!connected} onChange={event => setForm(current => ({ ...current, instruction: event.target.value }))} />
          <p className="text-chat-meta text-secondary">Group dispatch selects one eligible member of the group.</p>
          <div className="flex gap-2">
            <button type="button" className="btn text-chat-meta" disabled={assignDisabled || Object.keys(view.previewPending).length > 0}
              onClick={previewAssign} data-testid="task-detail-preview-button">Preview</button>
            <button type="button" className="btn btn-primary" disabled={assignDisabled}
              onClick={() => (outstanding ? setChoosing(true) : sendAssign())} data-testid="task-assign-send">Assign / send task</button>
            {form.requestKey && view.error && !outstanding && <button type="button" className="btn text-chat-meta" disabled={assignDisabled}
              onClick={() => sendAssign()} data-testid="task-retry-assign">Retry assignment</button>}
          </div>
        </div>
        {form.preview && view.preview && <TaskPreviewView preview={view.preview} />}
      </> : <div className="mt-2 border border-border p-2" data-testid="task-reassign-choice">
        <p className="text-chat-meta">This task already has an outstanding assignment: {outstanding ? outstandingLabel(outstanding) : ''}.</p>
        <p className="text-chat-meta text-secondary">Choose how to handle it — neither choice kills or archives anyone.</p>
        <label className="mt-1 block text-chat-meta"><input type="radio" checked={choice === 'notify'} onChange={() => setChoice('notify')} />
          Notify — send the previous assignee a note; their delivered work is untouched</label>
        <label className="block text-chat-meta"><input type="radio" checked={choice === 'stop'} onChange={() => setChoice('stop')} />
          Stop — also cancel the instruction while it is still queued</label>
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { setChoosing(false); sendAssign(choice) }}
            data-testid="task-reassign-confirm">Reassign ({choice})</button>
          <button type="button" className="btn" onClick={() => setChoosing(false)}>Cancel</button>
        </div>
      </div>}
      {detail.assignments.length > 0 && <details className="mt-2 text-chat-meta" data-testid="task-assignment-history">
        <summary>Assignment history ({detail.assignments.length})</summary>
        {detail.assignments.map(row => <p key={row.id} data-assignment-id={row.id} className="mt-1 border-l-2 border-border pl-2">
          {new Date(row.createdAt).toLocaleString()} · {row.targetKind === 'group' ? `group ${row.targetId}` : sessionLabel(row.targetId, sessions)} · {row.state}
          <span data-testid="assignment-dispatcher"> · by {actorLabel(row.createdBy, sessions)}</span>
          {row.claimedBy ? ` · claimed by ${sessionLabel(row.claimedBy, sessions)}` : ''}
          {row.reason ? ` · ${row.reason}` : ''}
        </p>)}
      </details>}
      </div>
    </Section>

    <Section teamPath={teamPath} name="Direction">
      <p className="mt-1 whitespace-pre-wrap text-chat-body" data-testid="task-direction">{task.direction}</p>
      <TaskDirectionEditor task={task} draft={detail.draft} connected={connected} disabled={disabled} act={act} />
    </Section>

    {task.acceptance && <Section teamPath={teamPath} name="Acceptance">
      <p className="mt-1 whitespace-pre-wrap text-chat-body" data-testid="task-acceptance">{task.acceptance}</p>
    </Section>}

    <Section teamPath={teamPath} name="Revision history">
      <div className="mt-1 text-chat-meta" data-testid="task-revisions">
        {detail.revisions.map(revision => <div key={revision.revision} data-revision={revision.revision} className="mt-2 border-l-2 border-border pl-2">
          <p className="text-secondary">Revision {revision.revision} · {actorLabel(revision.author, sessions)} · {new Date(revision.createdAt).toLocaleString()}</p>
          {revision.rationale && <p className="italic" data-testid="revision-rationale">Rationale: {revision.rationale}</p>}
          <p className="whitespace-pre-wrap">{revision.direction}</p>
          {revision.acceptance && <p className="whitespace-pre-wrap text-secondary">Acceptance: {revision.acceptance}</p>}
        </div>)}
      </div>
    </Section>

    <Section teamPath={teamPath} name="Results">
      <TaskResultsSection detail={detail} groups={groups} sessions={sessions} connected={connected} disabled={disabled} act={act} host={{ teamPath, sendMessage }} />
    </Section>
    <Section teamPath={teamPath} name="Release">
      <TaskReleaseDialog detail={detail} groups={groups} sessions={sessions} connected={connected} disabled={disabled} act={act} host={{ teamPath, sendMessage }} />
    </Section>

    <Section teamPath={teamPath} name="Publications">
      <TaskPublications task={task} publications={detail.publications ?? []} acknowledgements={detail.acknowledgements ?? []}
        sessions={sessions} disabled={disabled} act={act} onOpenMailbox={onOpenMailbox} />
    </Section>

    <Section teamPath={teamPath} name="Status">
      <div className="mt-1 flex flex-wrap gap-2">
        {TASK_STATUSES.filter(status => status !== task.status && !(status === 'done' && detail.executionOwned === true)).map(status =>
          <button key={status} className="btn text-chat-meta" disabled={disabled} onClick={() => act('status', { type: 'team-task-status', status })}>{statusLabel(status)}</button>)}
      </div>
    </Section>

    <Section teamPath={teamPath} name="Journal">
      {detail.journal.length === 0 && <p className="text-chat-meta text-secondary">No notes yet</p>}
      {detail.journal.map(entry => <article key={entry.id} className="mt-2 border-l-2 border-border pl-2">
        <p className="text-chat-meta text-secondary">{journalAuthorLabel(entry.author, sessions)} · {new Date(entry.createdAt).toLocaleString()}</p>
        <p className="whitespace-pre-wrap text-chat-body">{entry.text}</p>
      </article>)}
      <form className="mt-2 flex gap-2" onSubmit={event => {
        event.preventDefault()
        act('note', { type: 'team-task-note', text: note.trim() })
        setNote('')
      }}>
        <input className="input flex-1 text-chat-body" aria-label="Journal note" placeholder="Add a note" value={note} disabled={!connected} onChange={event => setNote(event.target.value)} />
        <button className="btn" disabled={disabled || !note.trim()}>Add note</button>
      </form>
    </Section>

    <Section teamPath={teamPath} name="Subtasks">
      {detail.subtasks.length === 0 && <p className="text-chat-meta text-secondary">No subtasks</p>}
      {detail.subtasks.map(child => <p key={child.id} className="text-chat-meta">
        <button className="hover:underline" onClick={() => go(child.id)}>{child.title}</button> · {child.status} · {assignmentLabel(child.assignment, sessions)}
      </p>)}
    </Section>

    <Section teamPath={teamPath} name="Messages">
      {detail.messages.length === 0 && <p className="text-chat-meta text-secondary">No messages</p>}
      {detail.messages.map(message => <article key={message.id} data-message-id={message.id} data-testid="message-row" className="mt-2 border border-border p-2">
        <MessageRow row={message} sessions={sessions} names={view.directory} onOpenSession={onOpenSession} />
        {onOpenThread && <button className="btn mt-1 text-chat-meta" data-testid="message-open-thread"
          onClick={() => onOpenThread(message.threadId)}>Open thread</button>}
      </article>)}
    </Section>

    <p className="mt-3 text-chat-meta text-secondary">Participants: {task.participants.length > 0 ? task.participants.map(id => sessionLabel(id, sessions)).join(', ') : 'none yet'}</p>
  </div>
}
