// The attention queue, morning summary, and bands (team-workspace 6.2/6.4):
// human-required items apart from agent waits, an unrecognized kind rendered
// not dropped, links that go to their source, eleven summary buckets with the
// runtime-only label, and bands that collapse per team.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AttentionItem, MorningSummary, TeamWorkspaceSnapshot } from '@shared/teamWorkspace'
import TeamAttentionQueue, { attentionKindLabel, focusAfterRemoval } from '../components/team/TeamAttentionQueue'
import TeamMorningSummary from '../components/team/TeamMorningSummary'
import TeamWorkspaceBands from '../components/team/TeamWorkspaceBands'
import { attentionLinkLabel, openAttentionLink } from '../components/team/attentionLinks'
// Server-built shapes (S2): the items and summary rows below are the server
// functions' own output, never hand-written copies of server shapes.
import { decisionQuestionItems, planStopItems, planSummaryRows, type PlanAttentionFact } from '../../server/team/planAttention'
import { attentionItems, type AttentionInput } from '../../server/team/workspaceRead'
import { morningSummary } from '../../server/team/workspaceSummary'
import type { ChangeSupervision } from '../../shared/planSupervision'
import { useSessionStore } from '../stores/sessionStore'
import { useTeamPlanStore } from '../stores/teamPlanStore'
import { useTeamTaskStore } from '../stores/teamTaskStore'
import { useTeamWorkspaceStore } from '../stores/teamWorkspaceStore'
import type { TeamLocation } from '../utils/teamLocation'

const item = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
  id, kind: id.split(':')[0]!, cause: `cause of ${id}`, owner: { kind: 'session', id: 's', label: 'dev one' },
  impact: { taskId: 't-1', taskTitle: 'Export' }, nextAction: 'Answer approval', link: { kind: 'chat', id: 's' },
  requiresHuman: true, ...extra,
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byId = (root: TestRenderer.ReactTestRenderer, id: string) => root.root.findAll(node => node.props['data-testid'] === id)

const summary = (extra: Partial<MorningSummary> = {}): MorningSummary => ({
  since: '2026-10-14T00:00:00.000Z',
  completedResults: { items: [] }, capacityWaits: { items: [], runtimeOnly: true }, approvals: { items: [] },
  uncertainDeliveries: { items: [] }, finishedTurnsWithoutResult: { items: [] }, outbound: { items: [] },
  landings: { items: [] }, stops: { items: [] }, stallAlerts: { items: [] }, decisions: { items: [] }, overrides: { items: [] },
  ...extra,
})
const snapshotOf = (attention: AttentionItem[], extra: Partial<MorningSummary> = {}): TeamWorkspaceSnapshot =>
  ({ tasks: [], attention, members: [], approvalDefault: null, directory: [], summary: summary(extra) })

beforeEach(() => {
  useTeamWorkspaceStore.setState({ views: {} })
  useSessionStore.setState({ selectedSessionId: null })
})
afterEach(() => {
  useTeamWorkspaceStore.setState({ views: {} })
  // The plan and card links set the Plans view's scroll target (plan-supervision D15).
  useTeamPlanStore.setState({ reveal: null })
})

test('human-required items are separated from agent-owned waits, with counts', () => {
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={entry => opened.push(entry.id)}
      items={[item('approval:a'), item('staffing-wait:m', { requiresHuman: false, nextAction: 'Wait for capacity' })]} />)
  })
  expect(textOf(byId(renderer, 'attention-summary')[0]!)).toContain('1 need you · 1 waiting on agents')
  const human = byId(renderer, 'attention-human')[0]!
  expect(human.findAll(node => node.props['data-testid'] === 'attention-item')).toHaveLength(1)
  expect(textOf(human)).toContain('Task Export')
  expect(textOf(byId(renderer, 'attention-agent')[0]!)).toContain('Wait for capacity')
  act(() => { byId(renderer, 'attention-action')[0]!.props.onClick() })
  expect(opened).toEqual(['approval:a'])
  // The link target is visible text, not only an accessible name.
  expect(textOf(byId(renderer, 'attention-action')[0]!)).toBe('Answer approval · Open chat')
})

test('an unrecognized kind still renders with its cause, owner, impact, and action', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}}
      items={[item('plan-hold:p1', { link: { kind: 'card', id: 'card-1' }, nextAction: 'Review hold' })]} />)
  })
  const rendered = textOf(byId(renderer, 'attention-item')[0]!)
  expect(rendered).toContain('plan-hold')
  expect(rendered).toContain('cause of plan-hold:p1')
  expect(rendered).toContain('dev one')
  expect(rendered).toContain('Review hold')
})

test('before the first snapshot the queue says loading, not empty', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamAttentionQueue loaded={false} onOpen={() => {}} items={[]} />) })
  expect(textOf(byId(renderer, 'attention-summary')[0]!)).toContain('loading')
  expect(byId(renderer, 'attention-empty')).toHaveLength(0)
})

test('links go to their source: a task, a mailbox row, a chat', () => {
  const navigated: TeamLocation[] = []
  const navigate = (location: TeamLocation) => navigated.push(location)
  openAttentionLink('/repo', { kind: 'task', id: 't-1' }, navigate)
  openAttentionLink('/repo', { kind: 'message', id: 'm-1' }, navigate)
  openAttentionLink('/repo', { kind: 'chat', id: 'chat-9' }, navigate)
  openAttentionLink('/repo', { kind: 'card', id: 'chat-8' }, navigate)
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'tasks', id: 't-1' }, { teamKey: '/repo', tab: 'mailbox' }])
  expect(useTeamWorkspaceStore.getState().views['/repo']?.tabs.mailbox.expanded).toEqual(['m-1'])
  // A chat link selects the chat (which leaves the Team page).
  expect(useSessionStore.getState().selectedSessionId).toBe('chat-8')
})

test('a plan link opens the named plan, preferring planId over the item id', () => {
  const navigated: TeamLocation[] = []
  const navigate = (location: TeamLocation) => navigated.push(location)
  openAttentionLink('/repo', { kind: 'plan', id: 'plan-stop:exec-1:api:0', planId: 'plan-1', change: 'api' }, navigate)
  openAttentionLink('/repo', { kind: 'plan', id: 'plan-2' }, navigate)
  expect(navigated).toEqual([
    { teamKey: '/repo', tab: 'plans', id: 'plan-1' },
    { teamKey: '/repo', tab: 'plans', id: 'plan-2' },
  ])
  expect(attentionLinkLabel({ kind: 'plan', id: 'plan-1' })).toBe('Open plan')
})

test('the summary shows all eleven buckets, the runtime-only label, and links', () => {
  const opened: string[] = []
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMorningSummary onOpen={entry => opened.push(entry.id)} summary={summary({
      capacityWaits: { runtimeOnly: true, items: [{ id: 'w', label: 'Waiting on devs cap', link: { kind: 'message', id: 'm' } }] },
      finishedTurnsWithoutResult: { items: [{ id: 'f', label: 'dev two finished a turn', link: { kind: 'chat', id: 's2' } }] },
      outbound: { items: [] },
    })} />)
  })
  const buckets = byId(renderer, 'summary-bucket')
  expect(buckets.map(bucket => bucket.props['data-bucket'])).toEqual([
    'Completed results', 'Capacity waits', 'Approvals', 'Uncertain deliveries', 'Finished turns without a result', 'Outbound sends',
    'Landings', 'Stopped changes', 'Stall alerts', 'Lead decisions', 'Overridden decisions',
  ])
  expect(textOf(buckets[1]!)).toContain('Runtime only')
  expect(textOf(buckets[0]!)).toContain('None.')
  expect(textOf(buckets[4]!)).toContain('dev two finished a turn')
  act(() => { byId(renderer, 'summary-item')[0]!.props.onClick() })
  expect(opened).toEqual(['w'])
})

test('bands collapse per team: attention starts open, the summary collapsed', () => {
  const element = (key: string) => <TeamWorkspaceBands teamKey={key} navigate={() => {}} snapshot={snapshotOf([item('approval:a')])} />
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(element('/repo')) })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(1)
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(0)
  expect(byId(renderer, 'band-toggle-attention')[0]!.props['aria-expanded']).toBe(true)
  act(() => { byId(renderer, 'band-toggle-summary')[0]!.props.onClick() })
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(1)
  act(() => { byId(renderer, 'band-toggle-attention')[0]!.props.onClick() })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(0)
  // Another team keeps its own defaults.
  act(() => { renderer.update(element('/other')) })
  expect(byId(renderer, 'team-attention-queue')).toHaveLength(1)
  expect(byId(renderer, 'team-morning-summary')).toHaveLength(0)
})

test('focus after a resolved item goes to the item now in its place, else the heading', () => {
  expect(focusAfterRemoval(['a', 'b', 'c'], ['a', 'c'], 'b')).toBe('c')
  expect(focusAfterRemoval(['a', 'b', 'c'], ['a', 'b'], 'c')).toBe('b')
  expect(focusAfterRemoval(['a'], [], 'a')).toBeNull()
  expect(focusAfterRemoval(['a', 'b'], ['a', 'b'], 'a')).toBeNull()
  expect(focusAfterRemoval(['a', 'b'], ['b'], null)).toBeNull()
})

test('the counts line is a polite status region and every action has a name', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}} items={[item('approval:a')]} />) })
  const summary = byId(renderer, 'attention-summary')[0]!
  expect(summary.props.role).toBe('status')
  expect(summary.props['aria-live']).toBe('polite')
  expect(String(byId(renderer, 'attention-action')[0]!.props['aria-label'])).toContain('Answer approval')
})

test('opening a chat from an item leaves the Tasks tab’s selection and filters in place', () => {
  const store = useTeamWorkspaceStore.getState()
  store.setFilters('/repo', 'tasks', { worktree: '/repo/.wt', awaitingHuman: true })
  store.setSearch('/repo', 'tasks', 'export')
  useTeamTaskStore.getState().open('/repo')
  useTeamTaskStore.getState().select('/repo', 't-1')
  openAttentionLink('/repo', { kind: 'chat', id: 'chat-5' }, () => {})
  expect(useSessionStore.getState().selectedSessionId).toBe('chat-5')
  expect(useTeamWorkspaceStore.getState().views['/repo']!.tabs.tasks).toMatchObject({ search: 'export', filters: { worktree: '/repo/.wt', awaitingHuman: true } })
  expect(useTeamTaskStore.getState().views['/repo']!.selectedTaskId).toBe('t-1')
  useTeamTaskStore.setState({ views: {} })
})

test('pending acceptance and fixes requested have labels; an unknown kind reads as itself', () => {
  expect(attentionKindLabel('pending-acceptance')).toBe('Pending acceptance')
  expect(attentionKindLabel('fixes-requested')).toBe('Fixes requested')
  expect(attentionKindLabel('context-exhausted')).toBe('Context exhausted')
  expect(attentionKindLabel('plan-hold')).toBe('plan-hold')
})

test('a fixes-requested item renders under agent-owned waits with its label and next action', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}}
      items={[item('fixes-requested:r-1', { requiresHuman: false, nextAction: 'Wait for fixes', link: { kind: 'task', id: 't-1' } })]} />)
  })
  const kinds = byId(renderer, 'attention-kind').map(textOf)
  expect(kinds).toEqual(['Fixes requested'])
  expect(textOf(renderer.root)).toContain('Wait for fixes')
})

test('the plan buckets render their items, none runtime-only (plan-supervision D13, B2)', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMorningSummary onOpen={() => {}} summary={summary({
      landings: { items: [{ id: 'landing:p:api:t', label: 'Change api of plan "Wave D" landed', link: { kind: 'plan', id: 'p', planId: 'p', change: 'api' } }] },
      stops: { items: [{ id: 'stop:p:api:t', label: 'Change api of plan "Wave D" stopped: CI did not finish in time', link: { kind: 'plan', id: 'p', planId: 'p', change: 'api' } }] },
      stallAlerts: { items: [{ id: 'stall-alert:a', label: 'Stall alert (no-progress) on change api of plan "Wave D"', link: { kind: 'plan', id: 'p', planId: 'p', change: 'api' } }] },
      decisions: { items: [{ id: 'decision:d', label: 'Decision recorded on plan "Wave D"', link: { kind: 'plan', id: 'p', planId: 'p' } }] },
      overrides: { items: [{ id: 'override:d', label: 'Decision overridden on plan "Wave D"', link: { kind: 'plan', id: 'p', planId: 'p' } }] },
    })} />)
  })
  const buckets = byId(renderer, 'summary-bucket')
  expect(textOf(buckets[6]!)).toContain('Change api of plan "Wave D" landed')
  expect(textOf(buckets[7]!)).toContain('CI did not finish in time')
  expect(textOf(buckets[8]!)).toContain('Stall alert (no-progress)')
  expect(textOf(buckets[9]!)).toContain('Decision recorded')
  expect(textOf(buckets[10]!)).toContain('Decision overridden')
  expect(byId(renderer, 'summary-runtime-only')).toHaveLength(1) // capacity waits only
})

test('a decision card carrying its plan opens the plan, labelled Open plan (plan-supervision D13, S1)', () => {
  const navigated: TeamLocation[] = []
  const navigate = (location: TeamLocation) => navigated.push(location)
  openAttentionLink('/repo', { kind: 'card', id: 'card-1', planId: 'plan-1' }, navigate)
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  expect(attentionLinkLabel({ kind: 'card', id: 'card-1', planId: 'plan-1' })).toBe('Open plan')
  // A session-shaped card (no plan) keeps its chat.
  openAttentionLink('/repo', { kind: 'card', id: 'chat-8' }, navigate)
  expect(navigated).toHaveLength(1)
  expect(useSessionStore.getState().selectedSessionId).toBe('chat-8')
})

test('server-built plan items and summary rows flow through the queue, links, and summary (S2, D13)', () => {
  // The facts are the store interface the gatherer fills; everything item-
  // shaped below is the server's own sources' output.
  const supervision: ChangeSupervision = {
    change: 'api', outcome: 'stopped',
    cause: { kind: 'stopped', reason: 'ci-timeout', detail: null },
    alsoApplying: [], stage: null, holder: null, progress: null, activity: null, stall: null, landing: null, lastRound: null,
  }
  const plans: PlanAttentionFact[] = [{
    teamId: 'team', planId: 'plan-1', planTitle: 'Wave D', leadGroup: 'lead', executionId: 'exec-1',
    changes: [{ taskId: 'task-1', generation: 0, supervision }],
    openCards: [{
      id: 'card-1', teamId: 'team', planId: 'plan-1', revision: 2, change: 'api', taskId: 'task-1',
      question: 'Which schema?', options: ['A', 'B'], context: null,
      askedBy: { session: 'chat-dev', group: 'middle-devs', profile: 'glm' },
      addressedTo: 'lead', addressedGroup: 'lead', messageId: null, createdAt: '2026-10-20T09:00:00.000Z',
    }],
    fixes: [], failedPromotion: null, correctionOpen: false,
  }]
  const input = {
    sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id,
    pendingAcceptance: [], outboundViolations: [], plans,
  } as unknown as AttentionInput
  const built = attentionItems(input)
  expect(built.filter(item => item.kind === 'plan-stop' || item.kind === 'decision-question')).toHaveLength(2)
  // The queue renders the server-built causes; the stop's link opens the plan,
  // and the card's planId makes its label Open plan (S1).
  const navigated: TeamLocation[] = []
  const navigate = (location: TeamLocation) => navigated.push(location)
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamAttentionQueue loaded onOpen={() => {}} items={built} />)
  })
  const rendered = textOf(renderer.root)
  expect(rendered).toContain('Change api of plan "Wave D" stopped')
  expect(rendered).toContain('Decision card asks: Which schema?')
  const stop = built.find(item => item.kind === 'plan-stop')!
  openAttentionLink('/repo', stop.link, navigate)
  expect(navigated).toEqual([{ teamKey: '/repo', tab: 'plans', id: 'plan-1' }])
  const cardItem = built.find(item => item.kind === 'decision-question')!
  expect(attentionLinkLabel(cardItem.link)).toBe('Open plan')
  // The summary's plan buckets render their server-built rows, linked to the plan.
  const rows = planSummaryRows({
    plans: { get: () => null },
    executions: {
      landingsSince: () => [],
      stoppedChangesSince: () => [{ planId: 'plan-1', change: 'api', updatedAt: '2026-10-20T10:00:00.000Z', stopReason: 'ci-timeout' }],
    },
    decisions: { decisionsSince: () => [] },
    alerts: { raisedSince: () => [] },
  } as never, 'team', '2026-10-19T12:00:00.000Z')
  const sum = morningSummary({
    now: '2026-10-20T12:00:00.000Z', sessions: [], messages: [], messageEvents: () => [], waiting: {}, turnEnds: [],
    nameOf: (id: string) => id, hasResult: () => false, results: [], outboundCounts: { allowed: 0, unknown: 0, violations: 0 },
    plans: rows,
  })
  expect(sum.stops.items.map(item => item.id)).toEqual(['stop:plan-1:api:2026-10-20T10:00:00.000Z'])
  let summaryRenderer!: TestRenderer.ReactTestRenderer
  act(() => {
    summaryRenderer = TestRenderer.create(<TeamMorningSummary onOpen={() => {}} summary={sum} />)
  })
  // The stub reads hold no plan row, so the label names the plan by id.
  expect(textOf(summaryRenderer.root)).toContain('Change api of plan "plan-1" stopped: CI did not finish in time')
})
