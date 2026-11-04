// The workspace read model's pure projections (team-workspace 2.2, 3.2, 4.1,
// 4.3): member rows over the layered catalog, task rows over assignment
// state, the attention registry, and the morning summary's buckets.
import { describe, expect, test } from 'bun:test'
import type { ChatPendingRequest } from '../../shared/chat'
import type { AttentionItem, TeamMemberRow } from '../../shared/teamWorkspace'
import type { TeamMessage, WaitingReason } from '../../shared/team'
import type { TeamTaskSummary } from '../../shared/teamTasks'
import type { ChatSessionRecord } from '../db'
import type { GroupCatalog } from '../team/groupCatalog'
import {
  WorkspaceRead,
  attentionItems,
  memberRows,
  taskRows,
  type AttentionInput,
} from '../team/workspaceRead'
import { morningSummary } from '../team/workspaceSummary'
import type { PendingAcceptance } from '../team/attentionAcceptance'
import { filterTeamTaskRows } from '../../shared/teamWorkspace'

const record = (overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord => ({
  sessionId: 'chat-1',
  name: 'Dev one',
  projectPath: '/repo',
  sdkSessionId: null,
  status: 'waiting',
  createdAt: '2026-10-14T00:00:00Z',
  lastActivityAt: '2026-10-14T01:00:00Z',
  ...overrides,
})

const approval = (overrides: Partial<Extract<ChatPendingRequest, { kind: 'approval' }>> = {}): ChatPendingRequest => ({
  kind: 'approval',
  requestId: 'req-1',
  tool: 'Bash',
  input: { command: 'ls' },
  at: '2026-10-14T06:00:00Z',
  ...overrides,
})

const question = (): ChatPendingRequest => ({
  kind: 'question',
  requestId: 'req-2',
  questions: [{ question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'A' }] }],
  at: '2026-10-14T06:30:00Z',
})

const message = (overrides: Partial<TeamMessage> = {}): TeamMessage => ({
  id: 'msg-1',
  teamId: 'team',
  toKind: 'group',
  toId: 'devs',
  fromKind: 'agent',
  fromSession: 'chat-9',
  fromGroup: 'leads',
  originPath: '/repo',
  priority: 'normal',
  tags: [],
  threadId: 'th-1',
  inReplyTo: null,
  hop: 1,
  body: 'Please review',
  state: 'queued',
  claimedBy: null,
  claimedAt: null,
  deliverAt: null,
  createdAt: '2026-10-14T05:00:00Z',
  pushedAt: null,
  deliveredAt: null,
  reason: null,
  possibleDuplicate: false,
  attachThread: false,
  taskId: null,
  taskRevision: null,
  claimCommit: null,
  parkedUntil: null,
  parkCount: 0,
  resumeMessageId: null,
  handoff: null,
  excludedProfile: null,
  ...overrides,
})

const reason = (blocker: WaitingReason['blocker']): WaitingReason => ({ blocker, others: [] })

const summary = (overrides: Partial<TeamTaskSummary> = {}): TeamTaskSummary => ({
  id: 'task-1',
  teamId: 'team',
  title: 'Build the thing',
  status: 'open',
  creator: { kind: 'human', sessionId: null },
  parentId: null,
  worktree: null,
  openspecChange: null,
  revision: 1,
  direction: 'd',
  acceptance: null,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
  participants: [],
  assignment: null,
  ...overrides,
})

const assignment = (overrides: Partial<NonNullable<TeamTaskSummary['assignment']>> = {}): TeamTaskSummary['assignment'] => ({
  id: 'as-1',
  taskId: 'task-1',
  requestKey: 'k',
  targetKind: 'group',
  targetId: 'devs',
  role: 'devs',
  instruction: 'go',
  createdBy: { kind: 'human', sessionId: null },
  messageId: 'msg-1',
  claimedBy: null,
  claimedAt: null,
  supersededBy: null,
  state: 'queued',
  reason: null,
  createdAt: '2026-10-14T00:00:00Z',
  updatedAt: '2026-10-14T00:00:00Z',
  ...overrides,
})

const catalog = (): GroupCatalog => ({
  groups: new Map([
    ['devs', {
      file: '/repo/.kawai/groups/devs.md',
      sources: [
        { file: '/home/.kawai/groups/devs.md', layer: 'user', inEffect: false },
        { file: '/repo/.kawai/groups/devs.md', layer: 'project', inEffect: true },
      ],
      group: {
        id: 'devs', label: 'Developers', description: 'Build features', canCreateTasks: true, canCreatePlans: false,
        releaseOnTaskClose: true, worktreeScoped: true, canReleaseMembers: true, canReportProcess: false, canManageMailbox: false,
        max: 3, profiles: [{ profileId: 'glm', cap: 2 }, { profileId: 'default', cap: 1 }],
        strategy: 'first-available',
        onLimit: { parkIfResetWithinMs: 10_800_000, otherwise: 'forward', forwardTo: 'seniors' },
        approval: 'manual', warnings: ['profile "nope" is not defined; ignored'], prompt: 'Build.',
      },
    }],
  ]),
  errors: [],
  warnings: [],
  providers: new Map([
    ['zai', { label: 'Z.AI', models: ['glm'] }],
    ['claude', { label: 'Claude', models: ['default'] }],
  ]),
})

describe('memberRows (2.2)', () => {
  /** The fixture's devs group with the `approval:` key removed, or set. */
  const withApproval = (approval: 'manual' | 'auto' | undefined): GroupCatalog => {
    const cat = catalog()
    const entry = cat.groups.get('devs')!
    const { approval: _drop, ...rest } = entry.group
    cat.groups.set('devs', { ...entry, group: approval === undefined ? rest : { ...rest, approval } })
    return cat
  }

  // @covers: team-workspace › Members is a read-only inspection of group settings › Approval source is shown
  test('O1: no key and no team default shows built-in manual', () => {
    expect(memberRows(withApproval(undefined), [], () => ({}))[0]).toMatchObject({ approval: 'manual', approvalSource: 'built-in' })
  })

  // @covers: team-workspace › The Members tab sets the team's default approval policy › Setting the default updates the group rows
  test('O3 and O6: the team default fills a group without the key; an explicit manual key keeps its own', () => {
    expect(memberRows(withApproval(undefined), [], () => ({}), 'auto')[0]).toMatchObject({ approval: 'auto', approvalSource: 'team' })
    expect(memberRows(withApproval('manual'), [], () => ({}), 'auto')[0]).toMatchObject({ approval: 'manual', approvalSource: 'group' })
  })

  test('a group row carries its settings, caps with live counts, warning, and both source files', () => {
    const rows = memberRows(catalog(), [record({ groupId: 'devs', claudeProfileId: 'glm' })], () => ({ glm: 1 }))
    expect(rows).toHaveLength(1)
    const row = rows[0]! as TeamMemberRow
    expect(row).toEqual({
      id: 'devs', label: 'Developers', description: 'Build features', canCreateTasks: true, max: 3,
      profiles: [
        { profileId: 'glm', providerId: 'zai', providerLabel: 'Z.AI', cap: 2, live: 1 },
        { profileId: 'default', providerId: 'claude', providerLabel: 'Claude', cap: 1, live: 0 },
      ],
      approval: 'manual', approvalSource: 'group', strategy: 'first-available',
      onLimit: { parkIfResetWithinMs: 10_800_000, otherwise: 'forward', forwardTo: 'seniors' },
      warnings: ['profile "nope" is not defined; ignored'],
      sources: [
        { file: '/home/.kawai/groups/devs.md', layer: 'user', inEffect: false },
        { file: '/repo/.kawai/groups/devs.md', layer: 'project', inEffect: true },
      ],
      members: [{ sessionId: 'chat-1', name: 'Dev one', spawned: false, profile: 'glm', status: 'waiting', taskId: null }],
    })
  })

  test('effort and profileEffort are projected as copies, and only when set', () => {
    const cat = catalog()
    const entry = cat.groups.get('devs')!
    const bare = memberRows(cat, [], () => ({}))[0]!
    expect('effort' in bare || 'profileEffort' in bare).toBe(false)
    entry.group.effort = 'low'
    entry.group.profileEffort = { haiku: 'xhigh' }
    const row = memberRows(cat, [], () => ({}))[0]!
    expect(row.effort).toBe('low')
    expect(row.profileEffort).toEqual({ haiku: 'xhigh' })
    expect(row.profileEffort).not.toBe(entry.group.profileEffort)
  })

  test('membership lists only live members of the group; archived and other groups stay out', () => {
    const rows = memberRows(
      catalog(),
      [
        record({ sessionId: 'live', groupId: 'devs' }),
        record({ sessionId: 'gone', groupId: 'devs', archivedAt: '2026-10-14T02:00:00Z' }),
        record({ sessionId: 'other', groupId: 'leads' }),
      ],
      () => ({}),
    )
    expect(rows[0]!.members.map(member => member.sessionId)).toEqual(['live'])
  })
})

describe('taskRows (3.2)', () => {
  test('a queued group assignment shows the requested role and no session; a claimed one names the session', () => {
    const rows = taskRows({
      summaries: [
        summary({ id: 'queued', assignment: assignment({ taskId: 'queued', state: 'queued' }) }),
        summary({ id: 'claimed', assignment: assignment({ taskId: 'claimed', state: 'claimed', claimedBy: 'chat-7' }) }),
      ],
      waiting: {},
      attention: [],
      nameOf: id => `Name of ${id}`,
      revisionsOf: () => ({ delivered: null, acknowledged: null }),
    })
    expect(rows[0]).toMatchObject({
      stage: 'unstarted', groupId: 'devs',
      accountable: { kind: 'group', id: 'devs', label: 'devs' },
      nextAction: 'Wait for capacity', requiresHuman: false,
    })
    expect(rows[1]).toMatchObject({
      stage: 'implementing', groupId: 'devs',
      accountable: { kind: 'session', id: 'chat-7', label: 'Name of chat-7' },
      nextAction: 'Wait for agent',
    })
  })

  test('the instruction mail waiting reason lands on the row; human-required attention flags it', () => {
    const attention: AttentionItem[] = [{
      id: 'approval:chat-1:req-1', kind: 'approval', cause: 'Approval requested: Bash',
      owner: { kind: 'session', id: 'chat-1', label: 'Dev one' }, impact: { taskId: 'task-1' },
      nextAction: 'Answer approval', link: { kind: 'chat', id: 'chat-1' }, requiresHuman: true,
    }]
    const rows = taskRows({
      summaries: [summary({ assignment: assignment({ state: 'queued' }) })],
      waiting: { 'msg-1': reason({ kind: 'group-cap', counts: { live: 2, cap: 2 } }) },
      attention,
      nameOf: () => 'x',
      revisionsOf: () => ({ delivered: null, acknowledged: null }),
    })
    expect(rows[0]!.waitingReason).toEqual({ blocker: { kind: 'group-cap', counts: { live: 2, cap: 2 } }, others: [] })
    expect(rows[0]!.requiresHuman).toBe(true)
  })
})

describe('attentionItems (4.1)', () => {
  const input = (): AttentionInput => ({
    sessions: [{
      record: record({ taskId: 'task-1' }),
      requests: [approval(), question()],
    }],
    messages: [
      message({ id: 'unc-1', state: 'uncertain', reason: 'transcript missing', taskId: 'task-1' }),
      message({ id: 'wait-1', state: 'queued', taskId: 'task-1' }),
      message({ id: 'ok-1', state: 'delivered' }),
    ],
    waiting: { 'wait-1': reason({ kind: 'group-cap', counts: { live: 1, cap: 1 } }) },
    taskTitle: id => (id === 'task-1' ? 'Build the thing' : null),
    nameOf: id => `Name of ${id}`,
    pendingAcceptance: [], outboundViolations: [],
  })

  test('one item per source kind with cause, owner, impact, next action, and link', () => {
    const items = attentionItems(input())
    expect(items.map(item => item.id)).toEqual([
      'approval:chat-1:req-1',
      'question:chat-1:req-2',
      'staffing-wait:wait-1',
      'uncertain-delivery:unc-1',
    ])
    const approvalItem = items.find(item => item.kind === 'approval')!
    expect(approvalItem).toMatchObject({
      cause: 'Approval requested: Bash',
      owner: { kind: 'session', id: 'chat-1', label: 'Dev one' },
      impact: { taskId: 'task-1', taskTitle: 'Build the thing' },
      nextAction: 'Answer approval',
      link: { kind: 'chat', id: 'chat-1' },
    })
    expect(items.find(item => item.kind === 'staffing-wait')).toMatchObject({
      cause: 'Group is at capacity (1/1)',
      nextAction: 'Wait for capacity',
      link: { kind: 'message', id: 'wait-1' },
    })
    expect(items.find(item => item.kind === 'uncertain-delivery')).toMatchObject({
      cause: 'Delivery uncertain: transcript missing',
      nextAction: 'Retry or discard',
      link: { kind: 'message', id: 'unc-1' },
    })
  })

  test('session owners carry the participant name, never the raw id (review item 5)', () => {
    const items = new Map(attentionItems(input()).map(item => [item.kind, item]))
    // The uncertain row's sender and the waiting row's recipient are sessions.
    expect(items.get('uncertain-delivery')!.owner).toEqual({ kind: 'session', id: 'chat-9', label: 'Name of chat-9' })
    const direct = attentionItems({
      ...input(),
      messages: [message({ id: 'wait-2', state: 'queued', toKind: 'session', toId: 'chat-2' })],
      waiting: { 'wait-2': reason({ kind: 'profile-cap', counts: { live: 1, cap: 1 }, detail: 'glm' }) },
    })
    expect(direct.find(item => item.id === 'staffing-wait:wait-2')!.owner)
      .toEqual({ kind: 'session', id: 'chat-2', label: 'Name of chat-2' })
  })

  test('requiresHuman splits human blocking from agent-owned waits', () => {
    const byKind = new Map(attentionItems(input()).map(item => [item.kind, item]))
    expect(byKind.get('approval')!.requiresHuman).toBe(true)
    expect(byKind.get('question')!.requiresHuman).toBe(true)
    expect(byKind.get('uncertain-delivery')!.requiresHuman).toBe(true)
    expect(byKind.get('staffing-wait')!.requiresHuman).toBe(false)
  })

  test('a non-capacity wait is not a staffing wait, and an unknown kind rides along', () => {
    const base = input()
    const withBusy = { ...base, waiting: { 'wait-1': reason({ kind: 'recipient-busy' }) } }
    expect(attentionItems(withBusy).filter(item => item.kind === 'staffing-wait')).toEqual([])
    // A Wave C source extends the registry; its unrecognized-kind item is
    // data like any other and never dropped (D5).
    const planHold: AttentionItem = {
      id: 'plan-hold:plan-2', kind: 'plan-hold', cause: 'Plan waits on a decision',
      owner: { kind: 'human', id: null, label: 'Human' }, impact: {},
      nextAction: 'Review the plan', link: { kind: 'card', id: 'plan-2' }, requiresHuman: true,
    }
    const items = attentionItems(base, [() => [planHold]])
    expect(items.map(item => item.id)).toContain('plan-hold:plan-2')
    expect(items.find(item => item.kind === 'plan-hold')).toEqual(planHold)
  })
})

describe('morningSummary (4.3)', () => {
  const now = '2026-10-14T12:00:00Z'
  const input = () => ({
    now,
    sessions: [{ record: record({ name: 'Dev one' }), requests: [approval({ at: '2026-10-14T08:00:00Z' }), question()] }],
    messages: [message({ id: 'unc-1', state: 'uncertain' })],
    messageEvents: (id: string) => id === 'unc-1'
      ? [{ kind: 'held-uncertain', createdAt: '2026-10-14T07:00:00Z' }]
      : [],
    waiting: { 'wait-1': reason({ kind: 'worktree-occupied', counts: { live: 1, cap: 1 }, detail: '/wt' }) },
    turnEnds: [
      { sessionId: 'chat-1', taskId: 'task-1', at: '2026-10-14T09:00:00Z' },
      { sessionId: 'chat-1', taskId: 'task-1', at: '2026-10-14T09:30:00Z' },
      // Outside the window: yesterday's turn never lands in the bucket.
      { sessionId: 'chat-1', taskId: 'task-1', at: '2026-10-13T09:00:00Z' },
    ],
    nameOf: (id: string) => `Name of ${id}`,
    hasResult: () => false, outboundCounts: { allowed: 0, unknown: 0, violations: 0 },
    results: [] as Array<{ resultId: string; taskId: string; taskTitle: string | null; submitter: string; accepted: boolean }>,
  })

  test('each bucket holds its items and capacity waits state their runtime bound', () => {
    const sum = morningSummary(input())
    expect(Date.parse(sum.since)).toBe(Date.parse('2026-10-13T12:00:00Z'))
    expect(sum.approvals.items).toEqual([
      { id: 'approval:chat-1:req-1', label: 'Dev one: Bash', link: { kind: 'chat', id: 'chat-1' } },
    ])
    expect(sum.uncertainDeliveries.items).toEqual([
      { id: 'uncertain-delivery:unc-1', label: 'Delivery uncertain', link: { kind: 'message', id: 'unc-1' } },
    ])
    expect(sum.capacityWaits).toEqual({
      items: [{ id: 'staffing-wait:wait-1', label: 'Worktree /wt is held (1/1)', link: { kind: 'message', id: 'wait-1' } }],
      runtimeOnly: true,
    })
    expect(sum.finishedTurnsWithoutResult.items).toEqual([
      { id: 'finished-turn:chat-1', label: 'Name of chat-1: 2 turns finished with no result', link: { kind: 'chat', id: 'chat-1' } },
    ])
    // Questions are attention items, not summary approvals.
    expect(sum.approvals.items).toHaveLength(1)
  })

  test('a turn with a result leaves the without-result bucket; completed results come only from result rows', () => {
    const withResult = morningSummary({ ...input(), hasResult: (_session, _task) => true })
    expect(withResult.finishedTurnsWithoutResult.items).toEqual([])
    expect(withResult.completedResults.items).toEqual([])
  })

  test('a simulated restart keeps the durable buckets and empties the runtime one', () => {
    const before = morningSummary(input())
    const afterRestart = morningSummary({ ...input(), waiting: {} })
    expect(afterRestart.uncertainDeliveries.items).toEqual(before.uncertainDeliveries.items)
    expect(afterRestart.approvals.items).toEqual(before.approvals.items)
    expect(afterRestart.finishedTurnsWithoutResult.items).toEqual(before.finishedTurnsWithoutResult.items)
    expect(afterRestart.capacityWaits.items).toEqual([])
  })

  test('an uncertain row whose hold event left the window is not listed; a resolved one leaves', () => {
    const oldHold = morningSummary({
      ...input(),
      messageEvents: () => [{ kind: 'held-uncertain', createdAt: '2026-10-10T00:00:00Z' }],
    })
    expect(oldHold.uncertainDeliveries.items).toEqual([])
    const resolved = morningSummary({ ...input(), messages: [message({ id: 'unc-1', state: 'delivered' })] })
    expect(resolved.uncertainDeliveries.items).toEqual([])
  })
})

describe('Phase 2 sources (11.1, 11.2)', () => {
  const resultOf = (extra: Partial<NonNullable<TeamTaskSummary['outstandingResult']>> = {}) =>
    ({ id: 'result-1', needsReevaluation: false, accepted: false, reviewVerdict: null, ...extra })
  const rowsFor = (summaries: TeamTaskSummary[], revisions = { delivered: 2 as number | null, acknowledged: 1 as number | null }) =>
    taskRows({ summaries, waiting: {}, attention: [], nameOf: id => id, revisionsOf: () => revisions })

  test('an unaccepted result shows Awaiting acceptance, flags re-evaluation, and the next action is Accept result', () => {
    const [row] = rowsFor([summary({ outstandingResult: resultOf({ needsReevaluation: true }) })])
    expect(row).toMatchObject({ stage: 'awaiting-acceptance', needsReevaluation: true, nextAction: 'Accept result' })
  })

  test('a queued review handoff outranks the unaccepted result it refers to', () => {
    const handoff = assignment({ state: 'queued', handoffKind: 'review', resultId: 'result-1' })
    const [row] = rowsFor([summary({ assignment: handoff, outstandingResult: resultOf() })])
    expect(row!.stage).toBe('in-review')
  })

  test('Awaiting acknowledgement keeps delivered and acknowledged revisions apart', () => {
    const claimed = assignment({ state: 'claimed', claimedBy: 'chat-7' })
    const [row] = rowsFor([summary({ revision: 3, assignment: claimed })])
    expect(row!.acknowledgement).toEqual({ revision: 3, deliveredRevision: 2, acknowledgedRevision: 1 })
    const [acknowledged] = rowsFor([summary({ revision: 3, assignment: claimed })], { delivered: 3, acknowledged: 3 })
    expect(acknowledged!.acknowledgement).toBeNull()
    // No claimant to acknowledge, or a closed task: no badge.
    expect(rowsFor([summary({ revision: 3, assignment: assignment({ state: 'queued' }) })])[0]!.acknowledgement).toBeNull()
    expect(rowsFor([summary({ revision: 3, status: 'done', assignment: claimed })])[0]!.acknowledgement).toBeNull()
  })

  const pending = (extra: Partial<PendingAcceptance> = {}): PendingAcceptance => ({
    resultId: 'result-1', taskId: 'task-1', submitter: 'Name of chat-3', submitterId: 'chat-3', needsReevaluation: false,
    reviewVerdict: null, liveCreator: null, ...extra,
  })
  const itemsFor = (extra: Partial<PendingAcceptance>) => attentionItems({
    sessions: [], messages: [], waiting: {}, taskTitle: () => 'Build the thing', nameOf: id => `Name of ${id}`,
    pendingAcceptance: [pending(extra)], outboundViolations: [],
  })

  test('failing findings: Fixes requested stage, Wait for fixes, and the awaiting-human filter drops the row', () => {
    const failing = summary({ outstandingResult: resultOf({ reviewVerdict: 'fail' }) })
    const [item] = itemsFor({ reviewVerdict: 'fail' })
    const [row] = taskRows({ summaries: [failing], waiting: {}, attention: [item!], nameOf: id => id, revisionsOf: () => ({ delivered: null, acknowledged: null }) })
    expect(row).toMatchObject({ stage: 'fixes-requested', nextAction: 'Wait for fixes', requiresHuman: false })
    const rows = [row!]
    expect(filterTeamTaskRows(rows, { awaitingHuman: true })).toEqual([])
    expect(filterTeamTaskRows(rows, { awaitingAcceptance: true })).toEqual([])
    // Passing findings keep it a normal acceptance row.
    const [passing] = rowsFor([summary({ outstandingResult: resultOf({ reviewVerdict: 'pass' }) })])
    expect(passing).toMatchObject({ stage: 'awaiting-acceptance', nextAction: 'Accept result' })
  })

  test('failing findings yield one agent-owned fixes-requested item owned by the submitter, and no pending acceptance', () => {
    const items = itemsFor({ reviewVerdict: 'fail', liveCreator: { sessionId: 'chat-lead', name: 'Lead' } })
    expect(items).toEqual([{
      id: 'fixes-requested:result-1', kind: 'fixes-requested',
      cause: 'Review of the result submitted by Name of chat-3 requested fixes',
      owner: { kind: 'session', id: 'chat-3', label: 'Name of chat-3' },
      impact: { taskId: 'task-1', taskTitle: 'Build the thing' },
      nextAction: 'Wait for fixes', link: { kind: 'task', id: 'task-1' }, requiresHuman: false,
    }])
  })

  test('a task created by a live agent session waits on that session, not the human', () => {
    const [item] = itemsFor({ liveCreator: { sessionId: 'chat-lead', name: 'Lead' } })
    expect(item).toMatchObject({
      id: 'pending-acceptance:result-1', kind: 'pending-acceptance',
      cause: 'Result submitted by Name of chat-3 awaits acceptance by Lead',
      owner: { kind: 'session', id: 'chat-lead', label: 'Lead' }, requiresHuman: false,
      impact: { taskId: 'task-1' }, link: { kind: 'task', id: 'task-1' },
    })
  })

  test('a pending acceptance is a human-required item linking to the task', () => {
    const items = attentionItems({
      sessions: [], messages: [], waiting: {}, taskTitle: () => 'Build the thing', nameOf: id => `Name of ${id}`,
      pendingAcceptance: [pending()], outboundViolations: [],
    })
    expect(items).toEqual([{
      id: 'pending-acceptance:result-1', kind: 'pending-acceptance',
      cause: 'Result submitted by Name of chat-3 awaits acceptance',
      owner: { kind: 'human', id: null, label: 'Human' },
      impact: { taskId: 'task-1', taskTitle: 'Build the thing' },
      nextAction: 'Accept result', link: { kind: 'task', id: 'task-1' }, requiresHuman: true,
    }])
  })
})

describe('completed results bucket (11.2)', () => {
  const base = {
    now: '2026-10-14T12:00:00Z', sessions: [], messages: [], messageEvents: () => [], waiting: {},
    turnEnds: [{ sessionId: 'chat-1', taskId: 'task-1', at: '2026-10-14T09:00:00Z' }],
    nameOf: (id: string) => `Name of ${id}`, outboundCounts: { allowed: 0, unknown: 0, violations: 0 },
  }

  test('submitted results are listed with their accepted state; a finished turn with none is not completed', () => {
    const sum = morningSummary({
      ...base, hasResult: () => false,
      results: [
        { resultId: 'r1', taskId: 'task-1', taskTitle: 'Export', submitter: 'Name of chat-2', accepted: false },
        { resultId: 'r2', taskId: 'task-2', taskTitle: null, submitter: 'Human', accepted: true },
      ],
    })
    expect(sum.completedResults.items).toEqual([
      { id: 'result:r1', label: 'Export: result by Name of chat-2 — awaiting acceptance', link: { kind: 'task', id: 'task-1' } },
      { id: 'result:r2', label: 'task-2: result by Human — accepted', link: { kind: 'task', id: 'task-2' } },
    ])
    // chat-1 finished a turn and submitted nothing: only its own bucket.
    expect(sum.finishedTurnsWithoutResult.items.map(item => item.id)).toEqual(['finished-turn:chat-1'])
    expect(sum.completedResults.items.some(item => item.id.includes('chat-1'))).toBe(false)
  })
})

describe('WorkspaceRead.snapshot labelling (bc0a329 follow-up)', () => {
  // A real human actor: no submitter session, the way a human-submitted
  // result is stored. The label must come from the actor, not from a
  // pre-labelled string the caller happened to pass.
  const humanResult = {
    id: 'r-human', taskId: 'task-1', summary: 'CSV export', commit: 'abc', diff: null,
    worktree: null, tests: [], limitations: null, taskRevision: 1,
    submittedBy: { kind: 'human', sessionId: null } as const,
    supersedesResultId: null, supersededBy: null, acceptedBy: null, acceptedAt: null, needsReevaluation: false,
  }
  const agentResult = {
    ...humanResult, id: 'r-agent', taskId: 'task-2',
    submittedBy: { kind: 'agent', sessionId: 'chat-9' } as const,
  }
  const summaryOf = (taskId: string, resultId: string, reviewVerdict: 'pass' | 'fail' | null = null, creator: TeamTaskSummary['creator'] = { kind: 'human', sessionId: null }): TeamTaskSummary => ({
    id: taskId, teamId: 'team', title: taskId === 'task-1' ? 'Export' : 'Import', status: 'active',
    creator, parentId: null, worktree: null, openspecChange: null,
    revision: 1, direction: 'Do it', acceptance: null, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z',
    participants: [], assignment: null,
    outstandingResult: { id: resultId, needsReevaluation: false, accepted: false, reviewVerdict },
  })

  test('a human-submitted result is labelled Human in attention and summary', () => {
    const results = [humanResult, agentResult]
    const manager = {
      tasks: {
        store: {
          list: () => [summaryOf('task-1', 'r-human'), summaryOf('task-2', 'r-agent')],
          get: (taskId: string) => summaryOf(taskId, taskId === 'task-1' ? 'r-human' : 'r-agent'),
          results: {
            get: (id: string) => results.find(result => result.id === id) ?? null,
            outstandingSince: () => results,
            submittedBy: () => false,
          },
          acknowledgements: { highest: () => null },
        },
      },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } },
      waitingFor: () => ({}),
      teamRecords: () => [record({ sessionId: 'chat-9', name: 'Agent nine' })],
      directory: { list: () => [] },
      getPendingRequests: () => [],
      teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}),
      teamApprovalDefault: () => null,
      turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [], outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
    }
    const snapshot = new WorkspaceRead(manager as never).snapshot({ teamId: 'team' } as never)

    const pending = snapshot.attention.find(item => item.id === 'pending-acceptance:r-human')
    expect(pending?.cause).toBe('Result submitted by Human awaits acceptance')
    expect(snapshot.summary.completedResults.items.map(item => item.label)).toEqual([
      'Export: result by Human — awaiting acceptance',
      'Import: result by Agent nine — awaiting acceptance',
    ])
  })
})

describe('WorkspaceRead.snapshot acceptance ownership (attention-acceptance-ownership)', () => {
  const result = (reviewVerdict: 'pass' | 'fail' | null) => ({
    id: 'r-1', taskId: 'task-1', summary: 'CSV export', commit: 'abc', diff: null, worktree: null, tests: [],
    limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'chat-dev' } as const,
    supersedesResultId: null, supersededBy: null, acceptedBy: null, acceptedAt: null, needsReevaluation: false, reviewVerdict,
  })
  const snapshotFor = (creator: TeamTaskSummary['creator'], records: ChatSessionRecord[], verdict: 'pass' | 'fail' | null = null, owned = false) => {
    const task = summary({
      id: 'task-1', teamId: 'team', title: 'Export', status: 'active', creator,
      outstandingResult: { id: 'r-1', needsReevaluation: false, accepted: false, reviewVerdict: verdict },
    })
    const manager = {
      tasks: { store: {
        list: () => [task], get: () => task,
        results: { get: () => result(verdict), outstandingSince: () => [], submittedBy: () => false },
        acknowledgements: { highest: () => null },
      } },
      mailbox: { store: { listForTeam: () => [], eventsFor: () => [] } },
      waitingFor: () => ({}),
      teamRecords: () => records,
      directory: { list: () => [] },
      getPendingRequests: () => [],
      teams: { catalogForTeam: () => ({ groups: new Map() }) },
      groupProfileCounts: () => ({}),
      teamApprovalDefault: () => null,
      turnEnds: { finishedForTeam: () => [] }, exhaustionEpisodes: () => [], outboundAudit: { violationGroups: () => [], windowCounts: () => ({ allowed: 0, unknown: 0, violations: 0 }) },
      results: { ownedByExecution: () => owned },
    }
    return new WorkspaceRead(manager as never).snapshot({ teamId: 'team' } as never)
  }
  const lead = { kind: 'agent', sessionId: 'chat-lead' } as const
  const dev = record({ sessionId: 'chat-dev', name: 'Dev' })

  // @covers: team-workspace › The attention queue lists what needs a human or is waiting on an agent › A running execution's task asks nothing of the human
  test('a task a running execution owns asks nothing of the human, even with no live creator', () => {
    const { attention, tasks } = snapshotFor({ kind: 'system', sessionId: null }, [dev], null, true)
    expect(attention.filter(item => item.kind === 'pending-acceptance')).toEqual([])
    expect(tasks[0]).toMatchObject({ requiresHuman: false, nextAction: 'Wait for Kawai' })
  })

  test('failing findings on an owned task still wait for fixes', () => {
    const { attention, tasks } = snapshotFor({ kind: 'system', sessionId: null }, [dev], 'fail', true)
    expect(attention.filter(item => item.kind === 'pending-acceptance')).toEqual([])
    expect(attention.filter(item => item.kind === 'fixes-requested').map(item => ({ owner: item.owner.id, requiresHuman: item.requiresHuman })))
      .toEqual([{ owner: 'chat-dev', requiresHuman: false }])
    expect(tasks[0]).toMatchObject({ nextAction: 'Wait for fixes' })
  })

  test('a human-created task stays human-required', () => {
    const { attention, tasks } = snapshotFor({ kind: 'human', sessionId: null }, [dev])
    expect(attention).toMatchObject([{ kind: 'pending-acceptance', owner: { kind: 'human' }, requiresHuman: true }])
    expect(tasks[0]!.requiresHuman).toBe(true)
  })

  test('a live agent creator owns the acceptance wait and the row is not human-blocked', () => {
    const { attention, tasks } = snapshotFor(lead, [dev, record({ sessionId: 'chat-lead', name: 'Lead' })])
    expect(attention).toMatchObject([{
      kind: 'pending-acceptance', owner: { kind: 'session', id: 'chat-lead', label: 'Lead' }, requiresHuman: false,
      cause: 'Result submitted by Dev awaits acceptance by Lead',
    }])
    expect(tasks[0]).toMatchObject({ requiresHuman: false, stage: 'awaiting-acceptance', nextAction: 'Accept result' })
  })

  test('an archived creator hands acceptance back to the human', () => {
    const archived = record({ sessionId: 'chat-lead', name: 'Lead', archivedAt: '2026-10-15T05:00:00Z' })
    const { attention } = snapshotFor(lead, [dev, archived])
    expect(attention).toMatchObject([{ kind: 'pending-acceptance', owner: { kind: 'human' }, requiresHuman: true }])
  })

  test('a killed creator (no session record) hands acceptance back to the human', () => {
    const { attention } = snapshotFor(lead, [dev])
    expect(attention).toMatchObject([{ kind: 'pending-acceptance', owner: { kind: 'human' }, requiresHuman: true }])
  })

  test('failing findings list one agent-owned wait owned by the submitter, even for a human-created task', () => {
    const { attention, tasks } = snapshotFor({ kind: 'human', sessionId: null }, [dev], 'fail')
    expect(attention).toMatchObject([{
      id: 'fixes-requested:r-1', kind: 'fixes-requested', owner: { kind: 'session', id: 'chat-dev', label: 'Dev' },
      nextAction: 'Wait for fixes', requiresHuman: false,
    }])
    expect(tasks[0]).toMatchObject({ stage: 'fixes-requested', nextAction: 'Wait for fixes', requiresHuman: false })
  })
})
