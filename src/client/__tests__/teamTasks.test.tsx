// Team task UI (team-tasks 7.1–7.3): the store's authoritative snapshots,
// the list/create view, the detail with its sections and human controls,
// and task context on live and replayed peer rows.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatEvent } from '@shared/chat'
import type { ClientMessage, Session } from '@shared/types'
import type { TeamTaskDetail as Detail, TeamTaskSummary } from '@shared/teamTasks'
import ChatMessages from '../components/chat/ChatMessages'
import TeamTasksPanel from '../components/team/TeamTasksView'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import { useChatStore } from '../stores/chatStore'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamTaskStore, type TaskView } from '../stores/teamTaskStore'

afterEach(() => {
  useTeamTaskStore.setState({ views: {} })
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ sessions: [] })
  useChatStore.setState({ sessions: {} })
})

const summary = (id: string, extra: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id, teamId: 'team', title: `Task ${id}`, status: 'open', creator: { kind: 'agent', sessionId: 'lead' }, parentId: null,
  worktree: null, openspecChange: null, revision: 1, direction: 'Build it', acceptance: null, createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z', participants: ['lead', 'dev'], assignment: null, ...extra,
})
const detail = (task: TeamTaskSummary, extra: Partial<Detail> = {}): Detail => ({
  task, revisions: [
    { revision: 1, direction: 'First plan', acceptance: null, author: { kind: 'agent', sessionId: 'lead' }, createdAt: '2026-10-11T00:00:00.000Z' },
    { revision: 2, direction: task.direction, acceptance: task.acceptance, author: { kind: 'human', sessionId: null }, createdAt: '2026-10-11T01:00:00.000Z' },
  ],
  journal: [
    { id: 'n1', author: { kind: 'agent', sessionId: 'dev' }, text: 'Picked option B', createdAt: '2026-10-11T02:00:00.000Z' },
    { id: 'n2', author: { kind: 'system', sessionId: null }, text: 'Released Dev one (dev): task done by human.', createdAt: '2026-10-11T03:00:00.000Z' },
  ],
  subtasks: [summary('child', { title: 'Export button', parentId: task.id })],
  assignments: [],
  messages: [{ id: 'm1', teamId: 'team', toKind: 'group', toId: 'devs', fromKind: 'agent', fromSession: 'lead', fromGroup: 'leads', originPath: '/repo', priority: 'normal',
    tags: [], threadId: 'm1', inReplyTo: null, hop: 1, body: 'Please build', state: 'delivered', claimedBy: 'dev', claimedAt: null, deliverAt: null,
    createdAt: '', pushedAt: null, deliveredAt: null, reason: null, possibleDuplicate: false, attachThread: false, taskId: task.id,
    taskRevision: null, claimCommit: null, parkedUntil: null, parkCount: 0, resumeMessageId: null, handoff: null, excludedProfile: null }],
  ...extra,
})
const sessionRow = (id: string, name: string) => ({ id, name, projectPath: '/repo', status: 'waiting', lastActivity: '', createdAt: '', source: 'managed', kind: 'chat' } as Session)
const text = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON())
/** Rendered text below a test instance (instances are cyclic; never stringify them). */
const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const openView = (): TaskView => {
  useTeamTaskStore.getState().open('dev')
  return useTeamTaskStore.getState().views.dev!
}

test('store: snapshots replace rows, closed views ignore pushes, results select a created task or show the refusal', () => {
  const store = useTeamTaskStore.getState()
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('a')] })
  expect(useTeamTaskStore.getState().views.dev).toBeUndefined()
  openView()
  expect(useTeamTaskStore.getState().views.dev!.loading).toBe(true)
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('a'), summary('b')] })
  store.applySnapshot({ type: 'team-tasks-snapshot', teamPath: 'dev', teamId: 'team', tasks: [summary('b')] })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ loading: false, tasks: [{ id: 'b' }] })
  store.begin('dev', 'r1', 'create')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r1', task: summary('new') })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ selectedTaskId: 'new', pending: {}, error: null })
  store.applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(summary('other')), directory: [] })
  expect(useTeamTaskStore.getState().views.dev!.detail).toBeNull()
  store.applyDetail({ type: 'team-task-detail', teamPath: 'dev', teamId: 'team', detail: detail(summary('new')), directory: [] })
  expect(useTeamTaskStore.getState().views.dev!.detail?.task.id).toBe('new')
  store.begin('dev', 'r2', 'status')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r2', error: 'Task not found in this team: x' })
  expect(useTeamTaskStore.getState().views.dev).toMatchObject({ error: 'Task not found in this team: x', pending: {} })
  store.close('dev')
  store.applyResult({ type: 'team-task-result', teamPath: 'dev', requestId: 'r3', error: 'late' })
  expect(useTeamTaskStore.getState().views.dev).toBeUndefined()
})

test('list shows title, status, creator, and participants; a killed creator is marked gone', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  const view = { ...openView(), loading: false, tasks: [summary('a', { status: 'blocked' }), summary('b', { creator: { kind: 'human', sessionId: null }, participants: [] })] }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={() => {}} connected />) })
  const rows = renderer.root.findAll(node => node.type === 'article' && !!node.props['data-task-id'])
  expect(rows.map(row => row.props['data-task-id'])).toEqual(['a', 'b'])
  expect(textOf(rows[0]!.findByProps({ 'data-testid': 'task-status' }))).toBe('blocked')
  expect(rows[0]!.findByProps({ 'data-testid': 'task-participants' }).children.join('')).toBe('Participants: lead (gone), Dev one')
  expect(textOf(rows[0]!)).toContain('created by lead (gone)')
  expect(textOf(rows[1]!)).toContain('created by Human')
  expect(rows[1]!.findByProps({ 'data-testid': 'task-participants' }).children.join('')).toBe('Participants: none yet')
  act(() => renderer.unmount())
})

test('create sends every field with a request id; disconnected disables it; errors show inline', () => {
  const sent: ClientMessage[] = []
  openView()
  let renderer!: TestRenderer.ReactTestRenderer
  // The draft lives in the store; render from it so typing re-renders.
  const render = (connected: boolean) => <TeamTasksPanel teamPath="dev" projectPath="/repo"
    view={{ ...useTeamTaskStore.getState().views.dev!, loading: false, tasks: [summary('parent')], error: connected ? null : '/nowhere is not a worktree of this team\'s repository' }}
    sendMessage={message => sent.push(message)} connected={connected} />
  act(() => { renderer = TestRenderer.create(render(true)) })
  const input = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  act(() => {
    input('Task title').props.onChange({ target: { value: ' Export ' } })
    input('Task direction').props.onChange({ target: { value: 'CSV' } })
    input('Acceptance criteria').props.onChange({ target: { value: 'Downloads' } })
    input('Parent task').props.onChange({ target: { value: 'parent' } })
    input('Target worktree').props.onChange({ target: { value: '/repo-feature' } })
    input('Linked OpenSpec change').props.onChange({ target: { value: 'add-export' } })
  })
  // The draft lives in the store: re-render so the typed values reach the form.
  act(() => renderer.update(render(true)))
  act(() => renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} }))
  expect(sent.filter(message => message.type === 'team-task-create')).toEqual([{ type: 'team-task-create', teamPath: 'dev', requestId: expect.any(String), requestKey: expect.any(String),
    title: 'Export', direction: 'CSV',
    acceptance: 'Downloads', parentId: 'parent', worktree: '/repo-feature', openspecChange: 'add-export' }])
  expect(Object.values(useTeamTaskStore.getState().views.dev!.pending)).toEqual(['create'])
  act(() => renderer.update(render(false)))
  expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain('/nowhere is not a worktree')
  expect(renderer.root.find(node => node.type === 'button' && node.children.includes('Create task')).props.disabled).toBe(true)
  expect(text(renderer)).toContain('Disconnected')
  act(() => renderer.unmount())
})

test('detail shows direction, retained revisions, journal, subtasks, messages; controls send amend, note, status, and reopen', () => {
  useSessionStore.setState({ sessions: [sessionRow('dev', 'Dev one')] })
  const sent: ClientMessage[] = []
  const task = summary('t1', { status: 'done', revision: 2, direction: 'Current plan', acceptance: 'Ships', openspecChange: 'add-export', worktree: '/repo-feature' })
  const view: TaskView = { ...openView(), loading: false, tasks: [task], selectedTaskId: 't1', detail: detail(task) }
  let renderer!: TestRenderer.ReactTestRenderer
  const render = (connected: boolean) => <TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={message => sent.push(message)} connected={connected} />
  act(() => { renderer = TestRenderer.create(render(true)) })
  expect(renderer.root.findAllByType('section').map(section => section.props['aria-label'])).toEqual(['Assignment', 'Direction', 'Acceptance', 'Revision history', 'Results', 'Release', 'Publications', 'Status', 'Journal', 'Subtasks', 'Messages'])
  expect(renderer.root.findByProps({ 'data-testid': 'task-direction' }).children.join('')).toBe('Current plan')
  expect(renderer.root.findByProps({ 'data-testid': 'task-acceptance' }).children.join('')).toBe('Ships')
  expect(renderer.root.findByProps({ 'data-testid': 'task-creator' }).children.join('')).toBe('lead (gone)')
  // Revision history starts collapsed (the once-per-team seed); open it to read the revisions.
  act(() => { renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props.onClick() })
  const revisions = renderer.root.findByProps({ 'data-testid': 'task-revisions' })
  expect(revisions.findAll(node => node.props['data-revision'] !== undefined && node.type === 'div').map(node => node.props['data-revision'])).toEqual([1, 2])
  expect(textOf(revisions)).toContain('First plan')
  for (const fragment of ['Picked option B', 'Dev one', 'Export button', 'Please build', 'add-export', 'authoritative direction', '/repo-feature']) {
    expect(text(renderer)).toContain(fragment)
  }
  // A system journal entry renders as kawai (member-release D4).
  expect(text(renderer)).toContain('Kawai')
  const button = (label: string) => renderer.root.find(node => node.type === 'button' && node.children.join('') === label)
  act(() => button('Reopen').props.onClick())
  act(() => button('Mark cancelled').props.onClick())
  const field = (label: string) => renderer.root.find(node => node.props['aria-label'] === label)
  // A draft first, then its publication (task-revision-publication 5.1/5.2).
  act(() => field('Draft direction').props.onChange({ target: { value: 'Revised plan' } }))
  act(() => button('Save draft').props.onClick())
  act(() => field('Rationale').props.onChange({ target: { value: 'Customer asked' } }))
  act(() => button('Publish revision 3').props.onClick())
  act(() => field('Journal note').props.onChange({ target: { value: 'Human note' } }))
  act(() => renderer.root.findAllByType('form').at(-1)!.props.onSubmit({ preventDefault: () => {} }))
  // Exactly one targets request per mount, not one per effect pass (N2).
  expect(sent.filter(message => message.type === 'team-task-targets')).toHaveLength(1)
  const actions = sent.filter(message => message.type.startsWith('team-task-') && message.type !== 'team-task-targets')
  expect(actions.map(message => ({ ...message, requestId: undefined, requestKey: undefined }) as Record<string, unknown>)).toEqual([
    { type: 'team-task-status', teamPath: 'dev', taskId: 't1', status: 'open' },
    { type: 'team-task-status', teamPath: 'dev', taskId: 't1', status: 'cancelled' },
    { type: 'team-task-draft', teamPath: 'dev', taskId: 't1', action: 'save', baseRevision: 2, direction: 'Revised plan', acceptance: 'Ships', rationale: '' },
    { type: 'team-task-publish', teamPath: 'dev', taskId: 't1', baseRevision: 2, direction: 'Revised plan', acceptance: 'Ships', rationale: 'Customer asked', notify: false, fromDraft: false },
    { type: 'team-task-note', teamPath: 'dev', taskId: 't1', text: 'Human note' },
  ].map(message => ({ ...message, requestId: undefined, requestKey: undefined })))
  expect(typeof (actions[3] as { requestKey?: string }).requestKey).toBe('string')
  act(() => renderer.update(render(false)))
  for (const node of renderer.root.findAll(node => node.type === 'button' && (/^Mark |^Reopen|^Save draft|^Publish|^Add note/).test(node.children.join('')))) {
    expect(node.props.disabled).toBe(true)
  }
  act(() => button('All tasks').props.onClick())
  expect(useTeamTaskStore.getState().views.dev!.selectedTaskId).toBeNull()
  act(() => renderer.unmount())
})

test('a task a running execution owns offers no Mark done, and still offers Mark cancelled', () => {
  const task = summary('t1', { status: 'active' })
  const statusButtons = (executionOwned: boolean) => {
    const view: TaskView = { ...openView(), loading: false, tasks: [task], selectedTaskId: 't1', detail: { ...detail(task), ...(executionOwned ? { executionOwned } : {}) } }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view} sendMessage={() => {}} connected />) })
    const labels = renderer.root.findAll(node => node.type === 'button').map(node => node.children.join(''))
    act(() => renderer.unmount())
    return labels
  }
  expect(statusButtons(false)).toContain('Mark done')
  expect(statusButtons(true)).not.toContain('Mark done')
  expect(statusButtons(true)).toContain('Mark cancelled')
})

test('peer rows show task context, live and after replay', () => {
  const peer: ChatEvent = { type: 'peer_message', id: 'p1', sequence: 1, at: 'now', turnId: 't', messageId: 'mail', senderSession: 'lead',
    senderGroup: 'leads', priority: 'normal', originPath: '/repo', tags: [], threadId: 'mail', body: 'Please build', possibleDuplicate: false,
    task: { id: 'task-1', title: 'Export', status: 'active', revision: 3, direction: 'CSV and JSON', acceptance: 'Downloads',
      openspecChange: 'add-export', worktree: '/repo-feature', journal: [{ author: 'qa', text: 'Schema needed', createdAt: '2026-10-11' }] } }
  const replayed: ChatEvent = { ...peer, id: 'p2', sequence: 0 }
  for (const event of [peer, replayed]) {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<ChatMessages events={[event]} />) })
    const section = renderer.root.findByProps({ 'data-testid': 'peer-task' })
    for (const fragment of ['Task: ', 'Export', 'active', 'revision ', '/repo-feature', 'add-export', 'CSV and JSON', 'Acceptance: ', 'Schema needed']) {
      expect(textOf(section)).toContain(fragment)
    }
    act(() => renderer.unmount())
  }
  let plain!: TestRenderer.ReactTestRenderer
  act(() => { plain = TestRenderer.create(<ChatMessages events={[{ ...peer, task: undefined } as ChatEvent]} />) })
  expect(plain.root.findAllByProps({ 'data-testid': 'peer-task' })).toHaveLength(0)
  act(() => plain.unmount())
})

describe('search and collapse (team-workspace-pages 5.5)', () => {
  afterEach(() => {
    useTeamWorkspaceStore.setState({ views: {} })
    useTeamTaskStore.setState({ views: {} })
  })

  const parent = summary('parent', { title: 'Export CSV', direction: 'Ship a CSV export', acceptance: 'Exports every row' })
  const child = summary('child-1', { title: 'Usage bar polish', parentId: 'parent', direction: 'Polish the usage bar' })
  const other = summary('other', { title: 'Unrelated work', direction: 'Something else' })
  const view = (): TaskView => ({ ...openView(), loading: false, tasks: [parent, child, other] })
  const mount = () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    return renderer
  }
  const rows = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'task-row' }).map(row => row.props['data-task-id'])

  test('search matches title and direction with the match marked, and a matching subtask keeps its parent', () => {
    const renderer = mount()
    expect(rows(renderer)).toEqual(['parent', 'child-1', 'other'])
    act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: 'usage bar' } }) })
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    // The matching subtask stays under its parent; the unrelated task drops.
    expect(rows(renderer)).toEqual(['parent', 'child-1'])
    expect(renderer.root.findAllByProps({ 'data-testid': 'task-no-matches' })).toHaveLength(0)
    // The matches themselves are marked, wherever they occur.
    const marks = renderer.root.findAllByProps({ 'data-testid': 'task-match' }).map(mark => mark.children.join(''))
    expect(marks).toContain('Usage bar')
    expect(marks).toContain('usage bar')
    // A needle nothing matches states it.
    act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: 'no such text' } }) })
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    expect(rows(renderer)).toEqual([])
    expect(renderer.root.findAllByProps({ 'data-testid': 'task-no-matches' })).toHaveLength(1)
    act(() => { renderer.unmount() })
  })

  test('collapsing a parent hides its subtasks and states their count', () => {
    const renderer = mount()
    const toggle = renderer.root.findAllByProps({ 'data-testid': 'task-parent-toggle' })[0]!
    expect(toggle.props['aria-expanded']).toBe(true)
    act(() => { toggle.props.onClick() })
    expect(rows(renderer)).toEqual(['parent', 'other'])
    expect(toggle.children.join('')).toContain('1 subtask')
    // The kept collapse state survives a remount (per-team view state, D8).
    act(() => { renderer.unmount() })
    const again = mount()
    expect(rows(again)).toEqual(['parent', 'other'])
    act(() => { again.unmount() })
  })

  test('opening the first detail preserves parents collapsed in the list', () => {
    const renderer = mount()
    act(() => { renderer.root.findAllByProps({ 'data-testid': 'task-parent-toggle' })[0]!.props.onClick() })
    expect(rows(renderer)).toEqual(['parent', 'other'])
    const selected = { ...view(), selectedTaskId: 'parent', detail: detail(parent) }
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={selected} sendMessage={() => {}} connected />) })
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props['aria-expanded']).toBe(false)
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    expect(rows(renderer)).toEqual(['parent', 'other'])
    act(() => { renderer.unmount() })
  })

  test('detail sections collapse independently and stay collapsed across tasks', () => {
    const first = { ...view(), selectedTaskId: 'parent', detail: detail(parent) }
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={first} sendMessage={() => {}} connected />) })
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Journal' }).props['aria-expanded']).toBe(true)
    // Revision history starts collapsed: the once-per-team seed applied itself.
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props['aria-expanded']).toBe(false)
    act(() => { renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Journal' }).props.onClick() })
    act(() => { renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props.onClick() })
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Journal' }).props['aria-expanded']).toBe(false)
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props['aria-expanded']).toBe(true)
    // Direction and Acceptance keep their own state while Journal stays collapsed…
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Direction' }).props['aria-expanded']).toBe(true)
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Acceptance' }).props['aria-expanded']).toBe(true)
    // …and opening another task finds Journal collapsed and the user's
    // expanded Revision history still expanded (5.5; the seed never re-applies).
    const second = { ...view(), selectedTaskId: 'other', detail: detail(other) }
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={second} sendMessage={() => {}} connected />) })
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Journal' }).props['aria-expanded']).toBe(false)
    expect(renderer.root.findByProps({ 'data-testid': 'task-section-toggle-Revision history' }).props['aria-expanded']).toBe(true)
    act(() => { renderer.unmount() })
  })

  test('a collapsed parent\'s toggle is disabled while searching and keeps its state once the search clears', () => {
    const renderer = mount()
    const toggle = () => renderer.root.findAllByProps({ 'data-testid': 'task-parent-toggle' })[0]!
    act(() => { toggle().props.onClick() })
    expect(rows(renderer)).toEqual(['parent', 'other'])
    act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: 'usage bar' } }) })
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    // Searching shows the subtask anyway; the toggle is disabled with a hint
    // and a click changes no stored state.
    expect(toggle().props.disabled).toBe(true)
    expect(toggle().props.title).toBe('Clear the search to collapse')
    act(() => { toggle().props.onClick() })
    // The ignored click left the stored collapse state exactly as it was
    // (compared as a snapshot, so other sections' state never matters here).
    const stored = useTeamWorkspaceStore.getState().views.dev!.tabs.tasks.collapsedSections
    expect(stored).toContain('parent:parent')
    act(() => { toggle().props.onClick() })
    expect(useTeamWorkspaceStore.getState().views.dev!.tabs.tasks.collapsedSections).toEqual(stored)
    // Clearing the search puts the parent back exactly as it was.
    act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: '' } }) })
    act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    expect(rows(renderer)).toEqual(['parent', 'other'])
    expect(toggle().props.disabled).toBe(false)
    act(() => { renderer.unmount() })
  })
})

test('a search overrides a collapsed parent and shows a snippet around a deep match', () => {
  const parent = summary('parent', { title: 'Export CSV', direction: 'Ship a CSV export' })
  const child = summary('child-deep', { title: 'Polish', direction: 'first line here\nand later the usage bar polish', parentId: 'parent' })
  const view = (): TaskView => ({ ...openView(), loading: false, tasks: [parent, child] })
  const mount = () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
    return renderer
  }
  const rows = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'task-row' }).map(row => row.props['data-task-id'])
  // Collapse the parent without a search…
  const renderer = mount()
  act(() => { renderer.root.findByProps({ 'data-testid': 'task-parent-toggle' }).props.onClick() })
  expect(rows(renderer)).toEqual(['parent'])
  // …then search for the subtask's deep direction text: the parent's
  // collapsed state is overridden and the subtask shows under it.
  act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: 'usage bar polish' } }) })
  act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
  expect(rows(renderer)).toEqual(['parent', 'child-deep'])
  expect(renderer.root.findAllByProps({ 'data-testid': 'task-match' }).map(mark => mark.children.join(''))).toContain('usage bar polish')
  // The matched row shows a snippet around the deep match, not only the first line.
  const line = renderer.root.findAllByProps({ 'data-testid': 'task-direction-line' })
    .find(node => node.props.children.props.text.includes('usage bar polish'))!
  expect(line.props.children.props.text).toContain('…')
  expect(line.props.children.props.text).not.toContain('first line here')
  // Clearing the search restores the parent's collapsed state.
  act(() => { renderer.root.findByProps({ 'aria-label': 'Search tasks' }).props.onChange({ target: { value: '' } }) })
  act(() => { renderer.update(<TeamTasksPanel teamPath="dev" projectPath="/repo" view={view()} sendMessage={() => {}} connected />) })
  expect(rows(renderer)).toEqual(['parent'])
  act(() => { renderer.unmount() })
})
