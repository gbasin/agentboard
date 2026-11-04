// The Members tab's team default approval control and source labels
// (team-approval-default D6/D7): the shown value is the snapshot's, a save
// sends the human action and waits, a refusal shows inline, and the control is
// disabled while disconnected with the last value kept. Group rows show the
// policy the server resolved with its source, never the team default itself.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ClientMessage } from '@shared/types'
import type { TeamMemberRow } from '@shared/teamWorkspace'
import TeamApprovalDefaultControl from '../components/team/TeamApprovalDefaultControl'
import TeamMembersPanel from '../components/team/TeamMembersPanel'
import { TaskPreviewView } from '../components/team/taskAssignFields'
import { useTeamWorkspaceDataStore } from '../stores/teamWorkspaceDataStore'
import { handleTeamApprovalDefaultResult } from '../protocol/teamWorkspaceMessages'

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props['data-testid'] === id)

let sent: ClientMessage[]
beforeEach(() => {
  sent = []
  useTeamWorkspaceDataStore.setState({ views: { '/repo': { teamId: 'team', snapshot: null } }, approvalSaves: {} })
})
afterEach(() => useTeamWorkspaceDataStore.setState({ views: {}, approvalSaves: {} }))

const mount = (value: 'manual' | 'auto' | null, connected = true) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamApprovalDefaultControl teamPath="/repo" value={value} connected={connected} sendMessage={message => sent.push(message)} />)
  })
  return renderer
}
const button = (renderer: TestRenderer.ReactTestRenderer, policy: 'manual' | 'auto') => byId(renderer, `team-approval-default-${policy}`)[0]!

test('an unset default says spawned members start on manual, and the hint names its scope', () => {
  const renderer = mount(null)
  expect(textOf(byId(renderer, 'team-approval-default-value')[0]!)).toBe('Not set: spawned members start on manual.')
  expect(textOf(byId(renderer, 'team-approval-default-hint')[0]!)).toContain('Applies to groups without an approval: key and only to members spawned from now on.')
  expect([button(renderer, 'manual').props['aria-pressed'], button(renderer, 'auto').props['aria-pressed']]).toEqual([false, false])
})

test('choosing auto sends the human action and waits for the answer', () => {
  const renderer = mount('manual')
  act(() => button(renderer, 'auto').props.onClick())
  expect(sent).toEqual([{ type: 'team-workspace-approval-default-set', teamPath: '/repo', policy: 'auto' }])
  expect(button(renderer, 'auto').props.disabled).toBe(true)
  // The current value again is not a save.
  act(() => handleTeamApprovalDefaultResult({ type: 'team-workspace-approval-default-result', teamPath: '/repo', ok: true, policy: 'auto' }))
  act(() => button(renderer, 'manual').props.onClick())
  expect(sent).toHaveLength(1)
  expect(button(renderer, 'auto').props.disabled).toBe(false)
})

test('a refusal shows inline and frees the control', () => {
  const renderer = mount('manual')
  act(() => button(renderer, 'auto').props.onClick())
  act(() => handleTeamApprovalDefaultResult({ type: 'team-workspace-approval-default-result', teamPath: '/repo', ok: false, error: 'Unknown team: /repo' }))
  expect(textOf(byId(renderer, 'team-approval-default-error')[0]!)).toBe('Unknown team: /repo')
  expect(button(renderer, 'auto').props.disabled).toBe(false)
})

// @covers: team-workspace › The Members tab sets the team's default approval policy › The control is disabled while disconnected
test('while disconnected the control is disabled, the last value stays, and a save in flight stops waiting', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  const render = (connected: boolean) => <TeamApprovalDefaultControl teamPath="/repo" value="auto" connected={connected} sendMessage={message => sent.push(message)} />
  act(() => { renderer = TestRenderer.create(render(true)) })
  act(() => button(renderer, 'manual').props.onClick())
  expect(useTeamWorkspaceDataStore.getState().approvalSaves['/repo']?.pending).toBe(true)
  act(() => renderer.update(render(false)))
  expect(useTeamWorkspaceDataStore.getState().approvalSaves['/repo']?.pending).toBe(false)
  expect([button(renderer, 'manual').props.disabled, button(renderer, 'auto').props.disabled]).toEqual([true, true])
  expect(textOf(byId(renderer, 'team-approval-default-value')[0]!)).toBe('Set to auto-approve.')
  act(() => button(renderer, 'manual').props.onClick())
  expect(sent).toHaveLength(1)
})

const row = (extra: Partial<TeamMemberRow>): TeamMemberRow => ({
  id: 'devs', label: 'devs', description: '', canCreateTasks: false, max: 1, profiles: [],
  approval: 'manual', approvalSource: 'built-in', strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: 0, otherwise: 'forward' }, warnings: [], sources: [], members: [], ...extra,
})

// @covers: team-workspace › The Members tab sets the team's default approval policy › Setting the default updates the group rows
test('group rows show the resolved policy with its source, beside the team control', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TeamMembersPanel loaded onOpenSession={() => {}}
      teamControl={<TeamApprovalDefaultControl teamPath="/repo" value="auto" connected sendMessage={() => {}} />}
      members={[
        row({ id: 'devs', approval: 'auto', approvalSource: 'team' }),
        row({ id: 'strict', approval: 'manual', approvalSource: 'group' }),
      ]} />)
  })
  expect(byId(renderer, 'team-approval-default')).toHaveLength(1)
  expect(byId(renderer, 'member-approval').map(node => textOf(node))).toEqual(['auto · team default', 'manual · group file'])
})

// @covers: team-workspace › Members is a read-only inspection of group settings › Approval source is shown
test('a group with neither key nor default shows built-in manual', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMembersPanel loaded onOpenSession={() => {}} members={[row({})]} />) })
  expect(byId(renderer, 'member-approval').map(node => textOf(node))).toEqual(['manual · built-in'])
})

// @covers: task-assignment › Dispatch can be previewed before sending › Group preview shows the resolved policy and its source
test('the dispatch preview names the policy a spawn gets and its source; a session preview names none', () => {
  const base = {
    worktree: '/repo', role: 'devs', profile: 'default', sessionWorktree: null, idleMembers: [],
    spawn: { allowed: true, profile: 'default', blockedBy: null }, warning: null,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<TaskPreviewView preview={{ ...base, target: { kind: 'group', id: 'devs' }, approval: 'auto', approvalSource: 'team' }} />)
  })
  expect(textOf(byId(renderer, 'task-preview-approval')[0]!)).toBe('Approval: auto · team default')
  act(() => renderer.update(<TaskPreviewView preview={{ ...base, target: { kind: 'session', id: 'chat-1' }, approval: 'manual' }} />))
  expect(textOf(byId(renderer, 'task-preview-approval')[0]!)).toBe('Approval: manual')
})
