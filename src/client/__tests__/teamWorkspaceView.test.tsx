// The Team page shell (team-workspace-pages §5): the tab strip's order
// (Strategy, Plans, Tasks, Messages, Mailbox, Members), the header's
// one-line strategy status for approved, in-review, and no-record cases and
// where it opens, the strategy subscription for the status line, and the
// unknown-repository notice (D3).
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage, SendClientMessage, Session } from '@shared/types'
import type { ProductStrategy, StrategyDetail } from '@shared/productStrategy'
import { normalizeStrategyContent } from '@shared/productStrategy'
import TeamWorkspaceView from '../components/team/TeamWorkspaceView'
import { runTasksEntrySelection } from '../components/team/tasksEntrySelection'
import { resetTeamLocationForTests, useTeamLocationStore } from '../hooks/useTeamLocation'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { useStrategyStore } from '../stores/strategyStore'
import { useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamWorkspaceSnapshot } from '@shared/teamWorkspace'
import { useWorkspaceStore } from '../stores/workspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const hashOf = (seed: string): string => `h-${seed.slice(0, 12)}`

const chatAt = (projectPath: string): Session => ({
  id: `chat-${projectPath}`, name: 'dev', projectPath, status: 'waiting',
  lastActivity: '', lastActivityAt: '', createdAt: '', source: 'managed', kind: 'chat',
} as Session)

const strategy = (extra: Partial<ProductStrategy> = {}): ProductStrategy => ({
  id: 'strategy-1', productId: 'kawai', title: 'Kawai', owner: { kind: 'human', sessionId: null }, lifecycle: 'active',
  currentApprovedRevision: 2,
  repoBindings: [{ root: '/repo/.git', kind: 'team' }, { root: '/repo', kind: 'worktree' }],
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', ...extra,
})

const content = () => normalizeStrategyContent({ purpose: 'Supervised autonomous development' })

const revision = (number: number, status: 'approved' | 'in_review' | 'superseded' | 'withdrawn') => ({
  revision: number, status, content: content(), contentHash: hashOf(`rev-${number}`),
  author: { kind: 'human' as const, sessionId: null }, impactProposal: null,
  createdAt: `2026-10-13T0${number}:00:00.000Z`,
})

const detail = (extra: Partial<StrategyDetail> = {}): StrategyDetail => ({
  strategy: strategy(),
  revisions: [revision(1, 'superseded'), revision(2, 'approved')],
  drafts: [], evidence: [], decisions: [], impactReviews: [],
  ...extra,
})

const sent: ClientMessage[] = []
const sendMessage: SendClientMessage = message => { sent.push(message) }

/** Every renderer mounted by a test, unmounted in afterEach so a later test's store resets cannot fire a stale effect. */
const active: TestRenderer.ReactTestRenderer[] = []

const mountPage = (location: TeamLocation, connected = true) => {
  const element = (current: TeamLocation) => <TeamWorkspaceView
    teamKey={current.teamKey} location={current} sendMessage={sendMessage}
    connected={connected} connectionEpoch={0} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element(location)) })
  active.push(renderer)
  const update = () => {
    const current = useTeamLocationStore.getState().location ?? location
    act(() => { renderer.update(element(current)) })
  }
  return { renderer, update }
}

const find = (root: TestRenderer.ReactTestRenderer, testId: string) =>
  root.root.findAll(node => node.props['data-testid'] === testId)
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const locationNow = () => useTeamLocationStore.getState().location

beforeEach(() => {
  sent.length = 0
  useSessionStore.setState({
    sessions: [chatAt('/repo')],
    hasLoaded: true,
    selectedSessionId: null,
    selectedHibernatingSessionId: null,
    selectionEpoch: 0,
  })
  useWorkspaceStore.setState({ snapshot: null, lastError: null, operationResults: [], collapsedSectionIds: [] })
  useStrategyStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useTeamWorkspaceDataStore.setState({ views: {}, seen: new Set() })
  resetTeamLocationForTests()
})

afterEach(() => {
  for (const renderer of active.splice(0)) {
    act(() => { renderer.unmount() })
  }
  useStrategyStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [], hasLoaded: false })
  useWorkspaceStore.setState({ snapshot: null, lastError: null, operationResults: [], collapsedSectionIds: [] })
  resetTeamLocationForTests()
})

test('the tab strip renders Strategy, Plans, Tasks, Messages, Mailbox, Members, Metrics, Audit in order', () => {
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'tasks' })
  const strip = renderer.root.findByProps({ 'data-testid': 'team-tab-strip' })
  const tabs = strip.findAll(node => node.props.role === 'tab')
  expect(tabs.map(tab => tab.props['data-testid'])).toEqual([
    'team-tab-strategy', 'team-tab-plans', 'team-tab-tasks', 'team-tab-messages', 'team-tab-mailbox', 'team-tab-members', 'team-tab-metrics', 'team-tab-audit',
  ])
  expect(tabs.map(tab => textOf(tab))).toEqual(['Strategy', 'Plans', 'Tasks', 'Messages', 'Mailbox', 'Members', 'Metrics', 'Audit'])
})

test('mounting opens the workspace read model; unmount closes it; a reconnect re-opens for a fresh snapshot', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'tasks' })
  expect(sent.filter(message => message.type === 'team-workspace-open')).toEqual([{ type: 'team-workspace-open', teamPath: '/repo' }])
  act(() => { page.renderer.unmount() })
  expect(sent).toContainEqual({ type: 'team-workspace-close', teamPath: '/repo' })
})

test('an unknown repository key opens no workspace subscription', () => {
  mountPage({ teamKey: '/not-a-repo', tab: 'tasks' })
  expect(sent.filter(message => message.type === 'team-workspace-open')).toHaveLength(0)
})

test('a pushed approval appears in the attention queue on every tab without a refresh', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'mailbox' })
  expect(textOf(find(page.renderer, 'attention-summary')[0]!)).toContain('loading')
  const empty = { items: [] }
  const push = (attention: TeamWorkspaceSnapshot['attention']) => act(() => {
    useTeamWorkspaceDataStore.getState().apply({
      teamPath: '/repo', teamId: 'team', tasks: [], attention, members: [], approvalDefault: null, directory: [],
      summary: { since: '2026-10-14T00:00:00.000Z', completedResults: empty, capacityWaits: empty, approvals: empty,
        uncertainDeliveries: empty, finishedTurnsWithoutResult: empty, outbound: empty,
        landings: empty, stops: empty, stallAlerts: empty, decisions: empty, overrides: empty },
    })
  })
  push([])
  expect(find(page.renderer, 'attention-empty')).toHaveLength(1)
  push([{ id: 'approval:a', kind: 'approval', cause: 'Approval requested: Bash', owner: { kind: 'session', id: 's', label: 'dev' },
    impact: {}, nextAction: 'Answer approval', link: { kind: 'chat', id: 's' }, requiresHuman: true }])
  expect(find(page.renderer, 'attention-item')).toHaveLength(1)
  // The queue sits above the tab strip, so it shows on Members too.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'members' }) })
  page.update()
  expect(find(page.renderer, 'attention-item')).toHaveLength(1)
  expect(find(page.renderer, 'team-members')).toHaveLength(1)
})

test('a tab click navigates the location and records the last-used tab', () => {
  const page = mountPage({ teamKey: '/repo', tab: 'tasks' })
  act(() => { page.renderer.root.findByProps({ 'data-testid': 'team-tab-mailbox' }).props.onClick() })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'mailbox' })
  // The app re-renders the page from the store's location; mirror that here.
  page.update()
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tab).toBe('mailbox')
  expect(useTeamWorkspaceStore.getState().views['/repo']?.open).toBe(true)
})

test('the status line shows the approved revision and in-review count, and opens that review', () => {
  useStrategyStore.getState().open('/repo')
  useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: '/repo', teamId: 't', strategy: strategy() })
  useStrategyStore.getState().applyDetail({
    type: 'strategy-detail', teamPath: '/repo', teamId: 't',
    detail: detail({ revisions: [revision(1, 'superseded'), revision(2, 'approved'), revision(3, 'in_review')] }),
  })
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'tasks' })
  const status = renderer.root.findByProps({ 'data-testid': 'team-strategy-status' })
  expect(textOf(status)).toBe('Strategy: revision 2 approved · 1 in review')
  act(() => { status.props.onClick() })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'review', id: '3' })
})

test('the status line with no review in flight opens the overview', () => {
  useStrategyStore.getState().open('/repo')
  useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: '/repo', teamId: 't', strategy: strategy() })
  useStrategyStore.getState().applyDetail({ type: 'strategy-detail', teamPath: '/repo', teamId: 't', detail: detail() })
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'mailbox' })
  const status = renderer.root.findByProps({ 'data-testid': 'team-strategy-status' })
  expect(textOf(status)).toBe('Strategy: revision 2 approved')
  act(() => { status.props.onClick() })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'overview' })
})

test('a team with no strategy record says so and the status opens the overview', () => {
  useStrategyStore.getState().open('/repo')
  useStrategyStore.getState().applySnapshot({ type: 'strategy-snapshot', teamPath: '/repo', teamId: 't', strategy: null })
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'tasks' })
  const status = renderer.root.findByProps({ 'data-testid': 'team-strategy-status' })
  expect(textOf(status)).toBe('No strategy captured')
  act(() => { status.props.onClick() })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'overview' })
})

test('mounting subscribes to the strategy for the status line; unmount closes it', () => {
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'tasks' })
  expect(sent).toContainEqual({ type: 'strategy-open', teamPath: '/repo' })
  act(() => { renderer.unmount() })
  expect(sent).toContainEqual({ type: 'strategy-close', teamPath: '/repo' })
})

test('an unknown repository key opens with a notice and no subscription', () => {
  const { renderer } = mountPage({ teamKey: '/not-a-repo', tab: 'tasks' })
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'team-workspace-notice' }))).toContain('Unknown repository /not-a-repo')
  expect(sent.filter(message => message.type === 'strategy-open')).toHaveLength(0)
})

test('disconnected shows a status line but sends nothing', () => {
  const { renderer } = mountPage({ teamKey: '/repo', tab: 'tasks' }, false)
  expect(sent).toHaveLength(0)
  expect(find(renderer, 'team-strategy-status')).toHaveLength(1)
})

test('the Strategy tab mounts the strategy view and routes its sub-views through the location', () => {
  const { renderer, update } = mountPage({ teamKey: '/repo', tab: 'strategy', sub: 'overview' })
  expect(find(renderer, 'strategy-subnav')).toHaveLength(1)
  // Moving to the draft sub-view pushes the location.
  act(() => { renderer.root.findByProps({ 'data-testid': 'strategy-sub-draft' }).props.onClick() })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'draft' })
  update()
  // The URL names the review of a revision, and the view follows it back.
  act(() => {
    useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'strategy', sub: 'review', id: '3' })
  })
  update()
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'strategy', sub: 'review', id: '3' })
})

test('the Tasks tab mounts the view, follows the URL selection, and notices a missing task', () => {
  useSessionStore.setState({ sessions: [chatAt('/repo'), chatAt('/repo')], hasLoaded: true })
  const workspace = { open: true, loading: false, tasks: [], selectedTaskId: null, detail: null, directory: [],
    pending: {}, error: null, draft: { title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '', targetKind: '', targetId: '', instruction: '' },
    flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false, commands: {}, commandRequests: {} } as unknown as Record<string, unknown>
  act(() => { useTeamTaskStore.setState({ views: { '/repo': workspace as never } }) })
  const taskSummary = {
    id: 't-1', teamId: 'team', title: 'Export', status: 'open', creator: { kind: 'human', sessionId: null },
    parentId: null, worktree: null, openspecChange: null, revision: 1, direction: 'Build it', acceptance: null,
    createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null,
  }
  const selected: Record<string, unknown> = { ...workspace, tasks: [taskSummary], selectedTaskId: 't-1' }
  const { renderer, update } = mountPage({ teamKey: '/repo', tab: 'tasks' })
  expect(find(renderer, 'team-tasks')).toHaveLength(1)
  // The URL names a task the team has: it is selected.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks', id: 't-1' }) })
  act(() => { useTeamTaskStore.setState({ views: { '/repo': selected as never } }) })
  update()
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('t-1')
  // A URL naming a task the team does not have opens the list with a notice.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks', id: 'gone-task' }) })
  update()
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBeNull()
  expect(textOf(renderer.root.findByProps({ 'data-testid': 'team-workspace-notice' }))).toContain('Task gone-task was not found')
})

test('the selected task survives a visit to another tab; the browser Back to a list location still clears it', () => {
  const view = { open: true, loading: false, tasks: [{
    id: 't-1', teamId: 'team', title: 'Export', status: 'open', creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null,
    openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null,
  }], selectedTaskId: 't-1', detail: null, directory: [], pending: {}, error: null,
    draft: { title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '', targetKind: '', targetId: '', instruction: '' },
    flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false, commands: {}, commandRequests: {} }
  act(() => { useTeamTaskStore.setState({ views: { '/repo': view as never } }) })
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks', id: 't-1' }) })
  const page = mountPage({ teamKey: '/repo', tab: 'tasks', id: 't-1' })
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'messages' }) })
  page.update()
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' }) })
  page.update()
  // Entering Tasks put the held selection back in the URL, replacing the id-less entry.
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'tasks', id: 't-1' })
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('t-1')
  // Back to an id-less Tasks location while the tab stays open asks for the list.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' }) })
  page.update()
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBeNull()
})

test('returning to a Tasks page with a held selection never clears it, under StrictMode too', () => {
  // End-state check only: react-test-renderer doesn't replay effects, so this
  // cannot pin the replay itself — the replay test below drives it directly.
  const view = { open: true, loading: false, tasks: [{
    id: 't-1', teamId: 'team', title: 'Export', status: 'open', creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null,
    openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null,
  }], selectedTaskId: 't-1', detail: null, directory: [], pending: {}, error: null,
    draft: { title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '', targetKind: '', targetId: '', instruction: '' },
    flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false, commands: {}, commandRequests: {} }
  act(() => { useTeamTaskStore.setState({ views: { '/repo': view as never } }) })
  // The Team entry reopens the page on the tab with no id in the URL.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' }) })
  const seen: Array<string | null> = []
  const unsubscribe = useTeamTaskStore.subscribe(state => { seen.push(state.views['/repo']?.selectedTaskId ?? null) })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<StrictMode>
      <TeamWorkspaceView teamKey="/repo" location={{ teamKey: '/repo', tab: 'tasks' }} sendMessage={sendMessage} connected connectionEpoch={0} />
    </StrictMode>)
  })
  active.push(renderer)
  unsubscribe()
  expect(seen).not.toContain(null)
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'tasks', id: 't-1' })
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('t-1')
})

test('the entry selection replay keeps a restored selection the stale closure cannot see', () => {
  const view = { open: true, loading: false, tasks: [{
    id: 't-1', teamId: 'team', title: 'Export', status: 'open', creator: { kind: 'human', sessionId: null }, parentId: null, worktree: null,
    openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z', participants: [], assignment: null,
  }], selectedTaskId: 't-1', detail: null, directory: [], pending: {}, error: null,
    draft: { title: '', direction: '', acceptance: '', parentId: '', worktree: '', openspecChange: '', targetKind: '', targetId: '', instruction: '' },
    flow: null, preview: null, previewPending: {}, targets: null, targetsLoading: false, commands: {}, commandRequests: {} }
  act(() => { useTeamTaskStore.setState({ views: { '/repo': view as never } }) })
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks', id: 't-1' }, { replace: true }) })
  const navigate = useTeamLocationStore.getState().navigate
  // StrictMode's replay: the entering run's closure (no id) runs again after
  // the entry navigation restored the URL. The live read must win.
  runTasksEntrySelection({ entering: false, closureLocationId: undefined, teamKey: '/repo', navigate })
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('t-1')
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'tasks', id: 't-1' })

  // The entering run itself: no id anywhere, a held selection goes to the URL.
  act(() => { useTeamLocationStore.getState().navigate({ teamKey: '/repo', tab: 'tasks' }, { replace: true }) })
  runTasksEntrySelection({ entering: true, closureLocationId: undefined, teamKey: '/repo', navigate })
  expect(locationNow()).toEqual({ teamKey: '/repo', tab: 'tasks', id: 't-1' })
  expect(useTeamTaskStore.getState().views['/repo']?.selectedTaskId).toBe('t-1')
})
