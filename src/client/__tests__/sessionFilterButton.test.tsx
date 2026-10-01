import { describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { HostStatus } from '@shared/types'
import SessionFilterButton from '../components/SessionFilterButton'

type Props = Parameters<typeof SessionFilterButton>[0]

const projects = ['/work/alpha', '/work/bravo', '/other/bravo']
const hosts = ['local', 'devbox']
const statuses: HostStatus[] = [
  { host: 'local', ok: true, lastUpdated: '2024-01-01T00:00:00.000Z' },
  { host: 'devbox', ok: false, error: 'ssh timeout', lastUpdated: '2024-01-01T00:00:00.000Z' },
]

function render(overrides: Partial<Props> = {}) {
  const calls = { projects: [] as string[][], hosts: [] as string[][] }
  const props: Props = {
    projects,
    selectedProjects: [],
    onSelectProjects: (next) => calls.projects.push(next),
    hosts,
    selectedHosts: [],
    onSelectHosts: (next) => calls.hosts.push(next),
    hostStatuses: statuses,
    showHosts: false,
    hasHiddenPermissions: false,
    ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<SessionFilterButton {...props} />)
  })
  const trigger = () =>
    renderer.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'menu')
  const open = () => act(() => trigger().props.onClick())
  const menu = () => renderer.root.findAll((n) => n.type === 'div' && n.props.role === 'menu')
  const groups = () =>
    renderer.root.findAll((n) => n.type === 'div' && n.props.role === 'group')
  const groupHeading = (group: TestRenderer.ReactTestInstance) =>
    group.findAll((n) => n.type === 'div' && typeof n.props.id === 'string')[0]?.children[0]
  const rowsOf = (group: TestRenderer.ReactTestInstance) =>
    group.findAll((n) => n.type === 'label').map((label) => ({
      text: label
        .findAll((n) => n.type === 'span')
        .map((span) => span.children.join(''))
        .join(' '),
      input: label.findByType('input'),
      title: label.props.title as string | undefined,
    }))
  const clearAll = () =>
    renderer.root.find((n) => n.type === 'button' && n.children.includes('Clear all'))
  const badge = () => renderer.root.findAll((n) => n.props['data-testid'] === 'filter-count-badge')
  const dot = () => renderer.root.findAll((n) => n.type === 'button' && n.props['data-testid'] === 'hidden-attention-dot')
  return { renderer, calls, trigger, open, menu, groups, groupHeading, rowsOf, clearAll, badge, dot }
}

describe('SessionFilterButton', () => {
  test('idle: a plain funnel labelled "Filter" with no badge', () => {
    const r = render()
    const trigger = r.trigger()
    expect(trigger.props['aria-label']).toBe('Filter')
    expect(trigger.props.title).toBe('Filter')
    expect(trigger.props['aria-expanded']).toBe(false)
    expect(trigger.props.className).toContain('text-secondary')
    expect(trigger.props.className).not.toContain('text-accent')
    expect(trigger.findAll((n) => n.type === 'svg')).toHaveLength(1)
    expect(r.badge()).toHaveLength(0)
    expect(r.dot()).toHaveLength(0)
    expect(r.menu()).toHaveLength(0)
    act(() => r.renderer.unmount())
  })

  test('active: accent funnel, badge counts every filter value, tooltip names them', () => {
    const r = render({
      selectedProjects: ['/work/alpha', '/other/bravo'],
      selectedHosts: ['devbox'],
      showHosts: true,
    })
    const trigger = r.trigger()
    expect(trigger.props.className).toContain('text-accent')
    expect(trigger.props.className).not.toContain('text-secondary')
    expect(r.badge()).toHaveLength(1)
    expect(r.badge()[0].children).toEqual(['3'])
    expect(trigger.props['aria-label']).toBe('Filter, 3 active filters')
    // Disambiguated project names, as the old dropdown showed them.
    expect(trigger.props.title).toBe('Filtered by Projects: alpha, other/bravo; Hosts: devbox')
    act(() => r.renderer.unmount())
  })

  test('a single filter value reads in the singular', () => {
    const r = render({ selectedHosts: ['devbox'] })
    expect(r.trigger().props['aria-label']).toBe('Filter, 1 active filter')
    expect(r.trigger().props.title).toBe('Filtered by Hosts: devbox')
    expect(r.badge()[0].children).toEqual(['1'])
    act(() => r.renderer.unmount())
  })

  test('hidden needs-input dot is separate from the badge and clears project filters', () => {
    const r = render({ selectedProjects: ['/work/alpha'], hasHiddenPermissions: true })
    const dots = r.dot()
    expect(dots).toHaveLength(1)
    expect(r.badge()).toHaveLength(1)
    // Not inside the funnel button, different color and corner from the badge.
    expect(r.trigger().findAll((n) => n.props['data-testid'] === 'hidden-attention-dot')).toHaveLength(0)
    expect(dots[0].props.className).toContain('bg-approval')
    expect(dots[0].props.className).toContain('pulse-approval')
    expect(dots[0].props.className).toContain('-bottom-1')
    expect(r.badge()[0].props.className).toContain('bg-accent')
    expect(r.badge()[0].props.className).toContain('-top-1.5')
    expect(dots[0].props.title).toBe('Hidden sessions need attention')
    let stopped = false
    act(() => dots[0].props.onClick({ stopPropagation: () => { stopped = true } }))
    expect(stopped).toBe(true)
    expect(r.calls.projects).toEqual([[]])
    act(() => r.renderer.unmount())
  })

  test('no dot without a project filter, even with hidden permissions', () => {
    const r = render({ selectedHosts: ['devbox'], hasHiddenPermissions: true })
    expect(r.dot()).toHaveLength(0)
    act(() => r.renderer.unmount())
  })

  test('one menu with Hosts and Projects sections when remotes exist', () => {
    const r = render({ showHosts: true, selectedHosts: ['devbox'] })
    r.open()
    expect(r.trigger().props['aria-expanded']).toBe(true)
    expect(r.menu()).toHaveLength(1)
    const groups = r.groups()
    expect(groups.map(r.groupHeading)).toEqual(['Hosts', 'Projects'])
    const hostRows = r.rowsOf(groups[0])
    expect(hostRows.map((row) => row.text)).toEqual(['All hosts', 'local', 'devbox offline'])
    expect(hostRows[0].input.props.checked).toBe(false)
    expect(hostRows[2].input.props.checked).toBe(true)
    expect(hostRows[2].title).toBe('devbox: ssh timeout')
    const projectRows = r.rowsOf(groups[1])
    expect(projectRows.map((row) => row.text)).toEqual([
      'All projects',
      'alpha',
      'work/bravo',
      'other/bravo',
    ])
    expect(projectRows[0].input.props.checked).toBe(true)
    expect(projectRows[1].title).toBe('/work/alpha')
    act(() => r.renderer.unmount())
  })

  test('no Hosts section without remote hosts', () => {
    const r = render({ showHosts: false })
    r.open()
    expect(r.groups().map(r.groupHeading)).toEqual(['Projects'])
    act(() => r.renderer.unmount())
  })

  test('checklists toggle in list order and "All" clears its section', () => {
    const r = render({ showHosts: true, selectedProjects: ['/other/bravo'] })
    r.open()
    const [hostGroup, projectGroup] = r.groups()
    act(() => r.rowsOf(projectGroup)[1].input.props.onChange())
    expect(r.calls.projects).toEqual([['/work/alpha', '/other/bravo']])
    act(() => r.rowsOf(projectGroup)[3].input.props.onChange())
    expect(r.calls.projects[1]).toEqual([])
    act(() => r.rowsOf(projectGroup)[0].input.props.onChange())
    expect(r.calls.projects[2]).toEqual([])
    act(() => r.rowsOf(hostGroup)[2].input.props.onChange())
    expect(r.calls.hosts).toEqual([['devbox']])
    act(() => r.renderer.unmount())
  })

  test('Clear all clears projects and hosts; disabled when nothing is filtered', () => {
    const idle = render()
    idle.open()
    expect(idle.clearAll().props.disabled).toBe(true)
    act(() => idle.renderer.unmount())

    const r = render({ showHosts: true, selectedProjects: ['/work/alpha'], selectedHosts: ['local'] })
    r.open()
    expect(r.clearAll().props.disabled).toBe(false)
    act(() => r.clearAll().props.onClick())
    expect(r.calls.projects).toEqual([[]])
    expect(r.calls.hosts).toEqual([[]])
    act(() => r.renderer.unmount())
  })

  test('menu opens downward by default and upward for the bottom anchor', () => {
    const down = render()
    down.open()
    expect(down.menu()[0].props.className).toContain('top-full')
    expect(down.menu()[0].props.className).not.toContain('bottom-full')
    act(() => down.renderer.unmount())

    const up = render({ placement: 'up' })
    up.open()
    expect(up.menu()[0].props.className).toContain('bottom-full')
    expect(up.menu()[0].props.className).not.toContain('top-full')
    act(() => up.renderer.unmount())
  })

  test('menu spans the filter bar and scrolls instead of leaving the viewport', () => {
    const r = render()
    r.open()
    const cls = r.menu()[0].props.className as string
    expect(cls).toContain('left-2 right-2')
    expect(cls).toContain('overflow-y-auto')
    expect(cls).toMatch(/max-h-\[min\(/)
    // The wrapper must not be the containing block, or the menu would size
    // to the 28px button instead of the bar.
    const wrapper = r.renderer.root.findByProps({ className: 'flex shrink-0' })
    expect(wrapper.props.className).not.toContain('relative')
    act(() => r.renderer.unmount())
  })
})
