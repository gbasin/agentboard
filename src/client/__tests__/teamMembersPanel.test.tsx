// Members (team-workspace 6.4): read-only settings inspection that names the
// source file of every group and both layers when both define it.
import { expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { TeamMemberRow } from '@shared/teamWorkspace'
import TeamMembersPanel from '../components/team/TeamMembersPanel'

const row = (extra: Partial<TeamMemberRow> = {}): TeamMemberRow => ({
  id: 'devs', label: 'Middle Dev', description: 'Implements ordinary tasks', canCreateTasks: false, max: 2,
  profiles: [
    { profileId: 'claude', providerId: 'claude', providerLabel: 'Claude', cap: 2, live: 1 },
    { profileId: 'glm', providerId: 'zai', providerLabel: 'Z.AI', live: 0 },
  ],
  approval: 'manual', approvalSource: 'built-in', strategy: 'first-available',
  onLimit: { parkIfResetWithinMs: 3 * 3_600_000, otherwise: 'forward', forwardTo: 'lead' },
  warnings: [], sources: [{ file: '/home/u/.kawai/groups/devs.md', layer: 'user', inEffect: true }],
  members: [{ sessionId: 'chat-1', name: 'dev one', spawned: true, profile: 'claude', status: 'working', taskId: 't-1' }],
  ...extra,
})

const textOf = (node: TestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
const mount = (members: TeamMemberRow[], opened: string[] = [], loaded = true) => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<TeamMembersPanel members={members} loaded={loaded} onOpenSession={id => opened.push(id)} />) })
  return renderer
}
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll(node => node.props['data-testid'] === id)

// @covers: team-workspace › Members is a read-only inspection of group settings › Caps show live counts
// @covers: team-workspace › Members is a read-only inspection of group settings › Workers are grouped by provider
test('caps show live counts and the live member is named', () => {
  const renderer = mount([row()])
  // Workers are grouped under their provider (design D13).
  expect(textOf(byId(renderer, 'member-profiles')[0]!)).toBe('Claude: claude · 1 of 2 · Z.AI: glm · 0 live')
  expect(textOf(byId(renderer, 'member-session')[0]!)).toContain('dev one · spawned · claude · working · task t-1')
  expect(textOf(byId(renderer, 'member-settings')[0]!)).toContain('park if reset within 3h, otherwise forward to lead')
})

test('a single-layer group names one file; both layers name both with the winner marked', () => {
  const single = mount([row()])
  expect(byId(single, 'member-sources')[0]!.findAllByType('li')).toHaveLength(1)
  expect(textOf(byId(single, 'member-sources')[0]!)).toContain('/home/u/.kawai/groups/devs.md')
  const both = mount([row({ sources: [
    { file: '/repo/.kawai/groups/devs.md', layer: 'project', inEffect: true },
    { file: '/home/u/.kawai/groups/devs.md', layer: 'user', inEffect: false },
  ] })])
  const items = byId(both, 'member-sources')[0]!.findAllByType('li')
  expect(textOf(items[0]!)).toContain('/repo/.kawai/groups/devs.md · project file · in effect')
  expect(textOf(items[1]!)).toContain('/home/u/.kawai/groups/devs.md · user file · overridden')
})

// @covers: team-workspace › Members is a read-only inspection of group settings › Per-profile effort is shown beside the group effort
test('the Effort row shows the group level, then per-profile levels: listed in group order, unlisted alphabetically', () => {
  const effort = (extra: Partial<TeamMemberRow>) => textOf(byId(mount([row(extra)]), 'member-effort')[0]!)
  expect(effort({})).toBe('Claude Code settings decide')
  expect(effort({ effort: 'low' })).toBe('low')
  expect(effort({ effort: 'low', profileEffort: { glm: 'max', claude: 'xhigh' } })).toBe('low · claude: xhigh · glm: max')
  expect(effort({ effort: 'low', profileEffort: { zed: 'high', haiku: 'xhigh', glm: 'medium' } }))
    .toBe('low · glm: medium · haiku: xhigh · zed: high')
  expect(effort({ profileEffort: { haiku: 'xhigh' } })).toBe('Claude Code settings decide · haiku: xhigh')
})

// @covers: team-workspace › Members is a read-only inspection of group settings › A warning names what fell back
test('warnings are shown beside the settings that took effect', () => {
  const renderer = mount([row({ warnings: ['profile "nope" is not defined; dropped'] })])
  expect(textOf(byId(renderer, 'member-warnings')[0]!)).toContain('profile "nope" is not defined; dropped')
})

// @covers: team-workspace › Members is a read-only inspection of group settings › Members cannot be edited
test('the panel is read-only: no inputs, and the only buttons open a member’s chat; the prompt caveat is stated', () => {
  const opened: string[] = []
  const renderer = mount([row()], opened)
  expect(renderer.root.findAll(node => ['input', 'textarea', 'select'].includes(String(node.type)))).toHaveLength(0)
  const buttons = renderer.root.findAllByType('button')
  expect(buttons).toHaveLength(1)
  act(() => { buttons[0]!.props.onClick() })
  expect(opened).toEqual(['chat-1'])
  // Each group row states it, not just the panel.
  expect(textOf(byId(renderer, 'member-prompt-note')[0]!)).toContain('future agent starts only')
})

test('every group row carries the prompt-change caveat', () => {
  const renderer = mount([row(), row({ id: 'leads', label: 'Leads' })])
  expect(byId(renderer, 'member-prompt-note')).toHaveLength(2)
})

test('loading and no-groups states are distinct', () => {
  expect(byId(mount([], [], false), 'members-empty')).toHaveLength(0)
  expect(byId(mount([]), 'members-empty')).toHaveLength(1)
})
