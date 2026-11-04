// The workspace read model on the client (team-workspace 4.2/6.3): snapshot
// and change pushes are the same replace, reached through the protocol
// router; counts converge after a reconnect; a toast fires once per
// human-required identity per client session and never for a replay.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { ServerMessage } from '@shared/types'
import type { AttentionItem, TeamWorkspaceSnapshot } from '@shared/teamWorkspace'
import { toastManager } from '../components/Toast'
import { createMessageRouter, type MessageRouterDeps } from '../protocol/messageRouter'
import { attentionCounts, useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'
import { rekeyTeamViewsForTests } from '../stores/teamViewMigration'
import { clearTeamKeyAliases } from '../utils/teamKeyAliases'

const item = (id: string, requiresHuman = true): AttentionItem => ({
  id, kind: id.split(':')[0]!, cause: `cause of ${id}`, owner: { kind: 'session', id: 's', label: 'dev' },
  impact: {}, nextAction: 'Answer approval', link: { kind: 'chat', id: 's' }, requiresHuman,
})

const bucket = { items: [] }
const snapshot = (attention: AttentionItem[]): TeamWorkspaceSnapshot => ({
  tasks: [], attention, members: [], approvalDefault: null, directory: [],
  summary: { since: '2026-10-14T00:00:00.000Z', completedResults: bucket, capacityWaits: bucket, approvals: bucket,
    uncertainDeliveries: bucket, finishedTurnsWithoutResult: bucket, outbound: bucket,
    landings: bucket, stops: bucket, stallAlerts: bucket, decisions: bucket, overrides: bucket },
})

const snapshotMessage = (attention: AttentionItem[], type: 'team-workspace-snapshot' | 'team-workspace' = 'team-workspace-snapshot', teamPath = '/repo'): ServerMessage =>
  ({ type, teamPath, teamId: 'team', ...snapshot(attention) })

const route = createMessageRouter({} as MessageRouterDeps)
let toasts: Array<{ title?: unknown; description?: unknown }> = []
let spy: ReturnType<typeof spyOn>

beforeEach(() => {
  useTeamWorkspaceDataStore.setState({ views: {}, seen: new Set() })
  clearTeamKeyAliases()
  toasts = []
  spy = spyOn(toastManager, 'add').mockImplementation(((toast: { title?: unknown; description?: unknown }) => { toasts.push(toast); return 't' }) as never)
})
afterEach(() => spy.mockRestore())

test('a snapshot reaches the store through the router and replaces the view', () => {
  useTeamWorkspaceDataStore.getState().open('/repo')
  route(snapshotMessage([item('approval:a')]))
  expect(useTeamWorkspaceDataStore.getState().views['/repo']?.snapshot?.attention.map(entry => entry.id)).toEqual(['approval:a'])
  route(snapshotMessage([item('approval:b')], 'team-workspace'))
  expect(useTeamWorkspaceDataStore.getState().views['/repo']?.snapshot?.attention.map(entry => entry.id)).toEqual(['approval:b'])
})

test('a snapshot for a page nobody opened is dropped', () => {
  route(snapshotMessage([item('approval:a')]))
  expect(useTeamWorkspaceDataStore.getState().views['/repo']).toBeUndefined()
})

test('the first snapshot is the baseline: waiting items do not toast', () => {
  useTeamWorkspaceDataStore.getState().open('/repo')
  route(snapshotMessage([item('approval:a')]))
  expect(toasts).toHaveLength(0)
})

test('a new human-required item toasts once; agent-owned waits never do', () => {
  useTeamWorkspaceDataStore.getState().open('/repo')
  route(snapshotMessage([]))
  route(snapshotMessage([item('approval:a'), item('staffing-wait:m', false)], 'team-workspace'))
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toMatchObject({ description: 'cause of approval:a' })
  route(snapshotMessage([item('approval:a'), item('staffing-wait:m', false)], 'team-workspace'))
  expect(toasts).toHaveLength(1)
})

test('agent-owned acceptance and fixes-requested items raise no toast', () => {
  useTeamWorkspaceDataStore.getState().open('/repo')
  route(snapshotMessage([]))
  route(snapshotMessage([item('pending-acceptance:r-1', false), item('fixes-requested:r-2', false)], 'team-workspace'))
  expect(toasts).toHaveLength(0)
  // The same acceptance turning human-required (its creator went away) toasts once.
  route(snapshotMessage([item('pending-acceptance:r-1', true), item('fixes-requested:r-2', false)], 'team-workspace'))
  expect(toasts).toHaveLength(1)
})

test('a context-exhausted item toasts once per episode; a later episode toasts again', () => {
  useTeamWorkspaceDataStore.getState().open('/repo')
  route(snapshotMessage([]))
  const first = item('context-exhausted:dev-1:2026-10-18T09:00:00.000Z')
  route(snapshotMessage([first], 'team-workspace'))
  route(snapshotMessage([first], 'team-workspace'))
  expect(toasts).toHaveLength(1)
  route(snapshotMessage([item('context-exhausted:dev-1:2026-10-18T12:00:00.000Z')], 'team-workspace'))
  expect(toasts).toHaveLength(2)
})

test('a replayed snapshot after a reconnect converges the counts with no toast', () => {
  const store = useTeamWorkspaceDataStore.getState()
  store.open('/repo')
  route(snapshotMessage([]))
  route(snapshotMessage([item('approval:a'), item('approval:b')], 'team-workspace'))
  expect(toasts).toHaveLength(2)
  // Disconnect: one approval is resolved while away; the reconnect snapshot replaces.
  route(snapshotMessage([item('approval:b')]))
  expect(attentionCounts(useTeamWorkspaceDataStore.getState().views['/repo']!.snapshot!.attention)).toEqual({ human: 1, agent: 0 })
  expect(toasts).toHaveLength(2)
  // The resolved item returning is the same identity: no second toast.
  route(snapshotMessage([item('approval:a'), item('approval:b')]))
  expect(toasts).toHaveLength(2)
})

test('seen identities are per client session, not per team', () => {
  const store = useTeamWorkspaceDataStore.getState()
  store.open('/repo')
  store.open('/other')
  route(snapshotMessage([]))
  route(snapshotMessage([item('approval:a')], 'team-workspace'))
  expect(toasts).toHaveLength(1)
  route(snapshotMessage([], 'team-workspace-snapshot', '/other'))
  route(snapshotMessage([item('approval:a')], 'team-workspace', '/other'))
  expect(toasts).toHaveLength(1)
})

test('rekey moves the view with its team and an existing target wins', () => {
  const store = useTeamWorkspaceDataStore.getState()
  store.open('/wt')
  route(snapshotMessage([item('approval:a')], 'team-workspace-snapshot', '/wt'))
  store.rekey('/wt', '/repo')
  expect(useTeamWorkspaceDataStore.getState().views['/wt']).toBeUndefined()
  expect(useTeamWorkspaceDataStore.getState().views['/repo']?.snapshot?.attention).toHaveLength(1)
})

test('discovery moving a team key carries the read model with it', () => {
  useTeamWorkspaceDataStore.getState().open('/wt')
  route(snapshotMessage([item('approval:a')], 'team-workspace-snapshot', '/wt'))
  rekeyTeamViewsForTests('/wt', '/repo')
  expect(useTeamWorkspaceDataStore.getState().views['/repo']?.snapshot?.attention).toHaveLength(1)
  // A push still in flight for the old key follows the view (teamKeyAliases).
  route(snapshotMessage([], 'team-workspace', '/wt'))
  expect(useTeamWorkspaceDataStore.getState().views['/repo']?.snapshot?.attention).toHaveLength(0)
})
