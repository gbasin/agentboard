// The Team page (team-workspace-pages §5): the team's full-width surface —
// a header naming the repository with a one-line strategy status that opens
// the Strategy tab (D5 replaces team-workspace's band), then the
// Strategy | Plans | Tasks | Messages | Mailbox | Members | Metrics tab strip, then the
// active tab's view. The page is the team views' only eventual host (D4); each tab
// view drives its own wire subscription, keyed by the team key. The URL
// location (D3) names the tab, sub-view, and selection; navigation goes
// through `useTeamLocationStore` so Back and Forward move with it.
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { SendClientMessage, ServerMessage } from '@shared/types'
import { useSessionStore } from '../../stores/sessionStore'
import { useStrategyStore, type StrategyView } from '../../stores/strategyStore'
import { useTeamMessageStore } from '../../stores/teamMessageStore'
import { useTeamWorkspaceStore } from '../../stores/teamWorkspaceStore'
import { useTeamWorkspaceDataStore } from '../../stores/teamWorkspaceDataStore'
import { useTeamMailboxStore } from '../../stores/teamMailboxStore'
import { useTeamPlanStore } from '../../stores/teamPlanStore'
import { useTeamAuditStore } from '../../stores/teamAuditStore'
import { useTeamTaskStore } from '../../stores/teamTaskStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useTeamLocationStore } from '../../hooks/useTeamLocation'
import { knownTeamKeys } from '../../utils/teamKey'
import { openParticipantChat } from '../chat/openParticipant'
import { useTeamGroups } from '../chat/useTeamGroups'
import ProductStrategyView from './ProductStrategyView'
import { runTasksEntrySelection } from './tasksEntrySelection'
import TeamMailboxView from './TeamMailboxView'
import TeamMessagesView from './TeamMessagesView'
import TeamMembersPanel from './TeamMembersPanel'
import TeamApprovalDefaultControl from './TeamApprovalDefaultControl'
import TeamPlansView from './TeamPlansView'
import TeamAuditView from './TeamAuditView'
import TeamTasksView from './TeamTasksView'
import TeamWorkspaceBands from './TeamWorkspaceBands'
import MetricsView, { resolveMetricsWindow } from './metrics/MetricsView'
import { useMetricsStore } from '../../stores/metricsStore'
import {
  RENDERED_WORKSPACE_TABS,
  type TeamLocation,
  type WorkspaceTab,
} from '../../utils/teamLocation'

const TAB_LABELS: Record<WorkspaceTab, string> = {
  strategy: 'Strategy',
  tasks: 'Tasks',
  messages: 'Messages',
  mailbox: 'Mailbox',
  members: 'Members',
  plans: 'Plans',
  metrics: 'Metrics',
  audit: 'Audit',
}

/** The one-line strategy status: approved revision or none, and reviews open. */
export function strategyStatusLine(view: StrategyView | undefined): { text: string; sub: 'overview' | 'review'; revision?: number } {
  if (!view?.seen) return { text: 'Strategy: loading…', sub: 'overview' }
  if (!view.strategy) return { text: 'No strategy captured', sub: 'overview' }
  const detail = view.detail
  const inReview = detail ? detail.revisions.filter(revision => revision.status === 'in_review') : []
  const approved = view.strategy.currentApprovedRevision
  const approvalText = approved != null ? `revision ${approved} approved` : 'no approved revision yet'
  const reviewText = inReview.length > 0 ? ` · ${inReview.length} in review` : ''
  const latest = inReview.at(-1)
  return latest
    ? { text: `Strategy: ${approvalText}${reviewText}`, sub: 'review', revision: latest.revision }
    : { text: `Strategy: ${approvalText}${reviewText}`, sub: 'overview' }
}

export default function TeamWorkspaceView({ teamKey, location, sendMessage, subscribe, onOpenNewSession, connected, connectionEpoch, onCreateWorktree }: {
  teamKey: string
  location: TeamLocation
  sendMessage: SendClientMessage
  /** The chat lifecycle subscription (the conversation panel's reset/create flows). */
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  /** Opens the normal New Session dialog (App-owned) for an unbound conversation role;
      `onDismissed` reports how the dialog flow ended (create-then-bind arm, B5). */
  onOpenNewSession?: (teamPath: string, onDismissed?: (created: boolean) => void) => void
  connected: boolean
  connectionEpoch: number
  /** Opens the repository branch browser (the task pickers' worktree creation). */
  onCreateWorktree?: (projectPath: string) => void
}) {
  // The page follows the location store directly, so a navigation re-renders
  // it even when a host's prop has not caught up; the prop seeds the first
  // render (App already gates mounting on a location existing).
  const storedLocation = useTeamLocationStore(state => state.location)
  const currentLocation = storedLocation ?? location
  const sessions = useSessionStore(state => state.sessions)
  const hasLoaded = useSessionStore(state => state.hasLoaded)
  const repositories = useWorkspaceStore(state => state.snapshot?.repositories)
  const workspace = useTeamWorkspaceStore(state => state.views[teamKey])
  const strategy = useStrategyStore(state => state.views[teamKey])
  const workspaceData = useTeamWorkspaceDataStore(state => state.views[teamKey])
  const navigate = useTeamLocationStore(state => state.navigate)

  // The page is open for this team; state stays across visits (D8).
  useEffect(() => {
    useTeamWorkspaceStore.getState().open(teamKey)
    return () => useTeamWorkspaceStore.getState().close(teamKey)
  }, [teamKey])
  // The URL's tab is the last-used tab (the header Team button reopens it).
  useEffect(() => { useTeamWorkspaceStore.getState().setTab(teamKey, currentLocation.tab) }, [teamKey, currentLocation.tab])

  // A key is known when it is a discovered repository's main checkout or a
  // chat's team key (the same population the server accepts, D1); anything
  // else opens the tab's default view with a notice (D3) and no subscription.
  const known = useMemo(
    () => knownTeamKeys(repositories, sessions),
    [repositories, sessions],
  )
  const unknown = hasLoaded && !known.has(teamKey)
  useEffect(() => {
    useTeamWorkspaceStore.getState().setNotice(teamKey, unknown ? `Unknown repository ${teamKey}` : null)
  }, [teamKey, unknown])

  // The status line reads the strategy snapshot the page subscribes to.
  useEffect(() => {
    if (!connected || unknown) return
    useStrategyStore.getState().open(teamKey)
    sendMessage({ type: 'strategy-open', teamPath: teamKey })
    return () => sendMessage({ type: 'strategy-close', teamPath: teamKey })
  }, [teamKey, connected, connectionEpoch, unknown, sendMessage])

  // The attention queue and morning summary read the workspace snapshot: one
  // authoritative snapshot on open and on every reconnect, then pushes (D6).
  useEffect(() => {
    if (!connected || unknown) return
    useTeamWorkspaceDataStore.getState().open(teamKey)
    sendMessage({ type: 'team-workspace-open', teamPath: teamKey })
    return () => sendMessage({ type: 'team-workspace-close', teamPath: teamKey })
  }, [teamKey, connected, connectionEpoch, unknown, sendMessage])

  // Messages (5.4): the tab mounts the host-agnostic view, which owns its
  // wire subscription; the store view stays open across tab switches so the
  // selection and search survive. The URL names the selected thread (D3).
  const messagesOpen = currentLocation.tab === 'messages' && !unknown
  const messages = useTeamMessageStore(state => state.views[teamKey])
  useEffect(() => {
    if (!messagesOpen) return
    useTeamMessageStore.getState().open(teamKey)
  }, [messagesOpen, teamKey])
  useEffect(() => {
    if (!messagesOpen) return
    // URL → store: a reloaded or linked location selects its thread.
    const store = useTeamMessageStore.getState()
    if ((currentLocation.id ?? null) !== store.views[teamKey]?.selectedThreadId) {
      store.select(teamKey, currentLocation.id ?? null)
    }
  }, [messagesOpen, teamKey, currentLocation.id])
  // Mailbox (5.3): the tab's snapshot subscription, mirroring the chat host.
  const mailboxOpen = currentLocation.tab === 'mailbox' && !unknown
  const mailbox = useTeamMailboxStore(state => state.views[teamKey])
  useEffect(() => {
    if (!connected || !mailboxOpen) return
    useTeamMailboxStore.getState().open(teamKey)
    sendMessage({ type: 'team-mailbox-open', teamPath: teamKey })
    return () => sendMessage({ type: 'team-mailbox-close', teamPath: teamKey })
  }, [teamKey, connected, connectionEpoch, mailboxOpen, sendMessage])

  // Tasks (5.5): the list subscription plus the selected task's detail, as
  // the chat host had them. The URL names the selection (D3): a reload or a
  // link re-selects it, and a location naming a task the team does not have
  // opens the list with a notice instead.
  const tasksOpen = currentLocation.tab === 'tasks' && !unknown
  const tasks = useTeamTaskStore(state => state.views[teamKey])
  useEffect(() => {
    if (!connected || !tasksOpen) return
    useTeamTaskStore.getState().open(teamKey)
    sendMessage({ type: 'team-tasks-open', teamPath: teamKey })
    return () => sendMessage({ type: 'team-tasks-close', teamPath: teamKey })
  }, [teamKey, connected, connectionEpoch, tasksOpen, sendMessage])
  // Entering is told apart here (the tab having just opened); the body lives
  // in tasksEntrySelection.ts so tests can drive StrictMode's same-closure
  // replay directly.
  const wasTasksOpen = useRef(false)
  useEffect(() => {
    if (!connected || !tasksOpen) { wasTasksOpen.current = false; return }
    const entering = !wasTasksOpen.current
    wasTasksOpen.current = true
    runTasksEntrySelection({ entering, closureLocationId: currentLocation.id, teamKey, navigate })
  }, [tasksOpen, teamKey, currentLocation.id, connected, tasks?.loading, tasks?.tasks]) // eslint-disable-line react-hooks/exhaustive-deps
  const selectedTaskId = tasks?.selectedTaskId ?? null
  useEffect(() => {
    if (!connected || !tasksOpen || !selectedTaskId) return
    sendMessage({ type: 'team-task-open', teamPath: teamKey, taskId: selectedTaskId })
    return () => sendMessage({ type: 'team-task-close', teamPath: teamKey, taskId: selectedTaskId })
  }, [teamKey, connected, connectionEpoch, tasksOpen, selectedTaskId, sendMessage])

  // Plans (durable-plans 8.3): the host-agnostic view owns its list and
  // detail subscriptions; the store view stays open across tab switches. The
  // URL names the selected plan (D3), so a reload or a link reopens it.
  const plansOpen = currentLocation.tab === 'plans' && !unknown
  const plans = useTeamPlanStore(state => state.views[teamKey])
  useEffect(() => {
    if (!plansOpen) return
    useTeamPlanStore.getState().open(teamKey)
  }, [plansOpen, teamKey])
  useEffect(() => {
    if (!plansOpen) return
    const store = useTeamPlanStore.getState()
    if ((currentLocation.id ?? null) !== (store.views[teamKey]?.selected ?? null)) store.select(teamKey, currentLocation.id ?? null)
  }, [plansOpen, teamKey, currentLocation.id])

  // Audit (execution-safety-recovery D9): the host-agnostic view owns its
  // subscription; the URL names the selected call, so a link reopens it.
  const auditOpen = currentLocation.tab === 'audit' && !unknown
  const audit = useTeamAuditStore(state => state.views[teamKey])
  useEffect(() => {
    if (!auditOpen) return
    useTeamAuditStore.getState().open(teamKey)
  }, [auditOpen, teamKey])
  useEffect(() => {
    if (!auditOpen) return
    const store = useTeamAuditStore.getState()
    if ((currentLocation.id ?? null) !== (store.views[teamKey]?.selected ?? null)) store.select(teamKey, currentLocation.id ?? null)
  }, [auditOpen, teamKey, currentLocation.id])

  // Metrics (team-process-metrics 7.2): the view owns its subscription; the
  // URL names the window (D5).
  const metricsOpen = currentLocation.tab === 'metrics' && !unknown
  const metrics = useMetricsStore(state => state.views[teamKey])
  useEffect(() => {
    if (!metricsOpen) return
    resolveMetricsWindow(teamKey, currentLocation.window, window => navigate({ teamKey, tab: 'metrics', window }, { replace: true }))
  }, [metricsOpen, teamKey, currentLocation.window, navigate])
  // Report authors and link actors by name; a killed session shows its id.
  const sessionName = useCallback((sessionId: string) => sessions.find(row => row.id === sessionId)?.name ?? sessionId, [sessions])

  const liveSessions = useMemo(
    () => sessions.map(row => ({ id: row.id, name: row.name, groupId: row.groupId ?? null })),
    [sessions],
  )
  // The groups list feeds the Messages composer and the Mailbox hand-off.
  const groups = useTeamGroups(messagesOpen || mailboxOpen, teamKey)

  const status = strategyStatusLine(strategy)
  const openTab = (tab: WorkspaceTab) => navigate({ teamKey, tab })
  const openStrategyStatus = () => navigate({
    teamKey, tab: 'strategy',
    ...(status.sub === 'review' && status.revision !== undefined ? { sub: 'review', id: String(status.revision) } : { sub: status.sub }),
  })

  return <main data-testid="team-workspace" data-team-key={teamKey} className="flex min-h-0 min-w-0 flex-1 flex-col bg-base text-primary">
    <header className="border-b border-border p-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="truncate font-medium" data-testid="team-workspace-title" title={teamKey}>
          {teamKey.split('/').filter(Boolean).at(-1) ?? teamKey} · Team
        </h2>
      </div>
      <button type="button" className="mt-0.5 text-left text-sm text-secondary hover:text-primary hover:underline"
        data-testid="team-strategy-status" onClick={openStrategyStatus}>
        {status.text}
      </button>
      {!connected && <p role="status" className="mt-1 text-sm text-secondary">Disconnected — reconnect to update this team.</p>}
      {workspace?.notice && <p role="status" data-testid="team-workspace-notice" className="mt-1 text-sm text-secondary">{workspace.notice}</p>}
    </header>
    <TeamWorkspaceBands teamKey={teamKey} snapshot={workspaceData?.snapshot ?? null} navigate={navigate} />
    <nav role="tablist" aria-label="Team views" className="flex gap-1 overflow-x-auto border-b border-border px-3 py-2" data-testid="team-tab-strip">
      {RENDERED_WORKSPACE_TABS.map(tab => (
        <button key={tab} type="button" role="tab" aria-selected={currentLocation.tab === tab}
          data-testid={`team-tab-${tab}`}
          className={`btn text-sm ${currentLocation.tab === tab ? 'btn-primary' : ''}`}
          onClick={() => openTab(tab)}>
          {TAB_LABELS[tab]}
        </button>
      ))}
    </nav>
    {/* The active tab's view; an unknown tab reads as the default, so the body always has a view. */}
    <div className="flex min-h-0 flex-1 flex-col" data-testid={`team-tab-body-${currentLocation.tab}`}>
      {messagesOpen && messages && <TeamMessagesView
        teamPath={teamKey} view={messages} sendMessage={sendMessage} connected={connected}
        connectionEpoch={connectionEpoch} sessions={liveSessions}
        groups={groups.groups.map(group => ({ id: group.id, label: group.label }))}
        onOpenSession={openParticipantChat}
        onThreadSelected={threadId => navigate(threadId
          ? { teamKey, tab: 'messages', id: threadId }
          : { teamKey, tab: 'messages' })}
      />}
      {currentLocation.tab === 'strategy' && !unknown && strategy && <ProductStrategyView
        teamPath={teamKey} view={strategy} sendMessage={sendMessage} connected={connected}
        sub={currentLocation.sub ?? 'overview'} revision={currentLocation.id}
        onNavigate={next => navigate({
          teamKey, tab: 'strategy', sub: next.sub,
          ...(next.revision !== undefined ? { id: String(next.revision) } : {}),
        })}
      />}
      {mailboxOpen && mailbox && <TeamMailboxView
        teamPath={teamKey} view={mailbox} sendMessage={sendMessage} connected={connected}
        groups={groups.groups.map(group => group.id)} sessions={liveSessions}
        onOpenSession={openParticipantChat}
      />}
      {currentLocation.tab === 'members' && !unknown && <TeamMembersPanel
        members={workspaceData?.snapshot?.members ?? []} loaded={workspaceData?.snapshot != null}
        onOpenSession={openParticipantChat}
        teamControl={workspaceData?.snapshot != null && <TeamApprovalDefaultControl
          teamPath={teamKey} value={workspaceData.snapshot.approvalDefault ?? null} connected={connected} sendMessage={sendMessage} />} />}
      {tasksOpen && tasks && <TeamTasksView
        teamPath={teamKey} projectPath={teamKey} view={tasks} rows={workspaceData?.snapshot?.tasks} sendMessage={sendMessage} connected={connected}
        connectionEpoch={connectionEpoch}
        onSelectedTask={taskId => navigate(taskId
          ? { teamKey, tab: 'tasks', id: taskId }
          : { teamKey, tab: 'tasks' })}
        onOpenThread={threadId => navigate({ teamKey, tab: 'messages', id: threadId })}
        onOpenMailbox={() => navigate({ teamKey, tab: 'mailbox' })}
        onOpenSession={openParticipantChat}
        {...(onCreateWorktree ? { onCreateWorktree: () => onCreateWorktree(teamKey) } : {})}
      />}
      {plansOpen && plans && <TeamPlansView
        teamPath={teamKey} view={plans} sendMessage={sendMessage} subscribe={subscribe}
        onOpenNewSession={onDismissed => onOpenNewSession?.(teamKey, onDismissed)} connected={connected}
        connectionEpoch={connectionEpoch} sessions={sessions}
        onOpenTask={taskId => navigate({ teamKey, tab: 'tasks', id: taskId })}
        onSelectedPlan={planId => navigate(planId ? { teamKey, tab: 'plans', id: planId } : { teamKey, tab: 'plans' })}
        onOpenImpactReview={revision => navigate({ teamKey, tab: 'strategy', sub: 'impact', id: String(revision) })}
        onCaptureStrategy={() => navigate({ teamKey, tab: 'strategy', sub: 'overview' })}
      />}
      {auditOpen && audit && <TeamAuditView
        teamPath={teamKey} view={audit} sendMessage={sendMessage} connected={connected}
        connectionEpoch={connectionEpoch}
        onSelectedCall={callId => navigate(callId ? { teamKey, tab: 'audit', id: callId } : { teamKey, tab: 'audit' })}
      />}
      {metricsOpen && <MetricsView
        teamPath={teamKey} view={metrics} locationWindow={currentLocation.window} reportId={currentLocation.id} sendMessage={sendMessage}
        connected={connected} connectionEpoch={connectionEpoch} nameOf={sessionName}
        onWindow={(window, options) => navigate({ teamKey, tab: 'metrics', window }, options)}
        onOpenReport={reportId => navigate({ teamKey, tab: 'metrics', window: currentLocation.window, ...(reportId ? { id: reportId } : {}) })}
        onOpenTask={taskId => navigate({ teamKey, tab: 'tasks', id: taskId })}
        onOpenThread={threadId => navigate({ teamKey, tab: 'messages', id: threadId })}
      />}
    </div>
  </main>
}
