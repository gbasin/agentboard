import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { HostStatus } from '@shared/types'
import SessionFilterButton, {
  FILTER_SEARCH_THRESHOLD,
  matchesFilterQuery,
} from '../components/SessionFilterButton'

type Props = Parameters<typeof SessionFilterButton>[0]

const projects = ['/work/alpha', '/work/bravo', '/other/bravo']
const hosts = ['local', 'devbox']
const statuses: HostStatus[] = [
  { host: 'local', ok: true, lastUpdated: '2024-01-01T00:00:00.000Z' },
  { host: 'devbox', ok: false, error: 'ssh timeout', lastUpdated: '2024-01-01T00:00:00.000Z' },
]

/** 30 projects: past the search threshold. */
const manyProjects = Array.from({ length: 30 }, (_, i) => `/work/p${String(i).padStart(2, '0')}`)

type Listener = (event: { key: string; target?: unknown }) => void

/**
 * Minimal document/window stand-ins: the menu's Escape handling listens on
 * document, and focus-on-open reads window.matchMedia. Restored after each
 * test because client test files share one process.
 */
const globals = globalThis as unknown as { document?: unknown; window?: unknown }
const saved = { document: globals.document, window: globals.window }
afterEach(() => {
  globals.document = saved.document
  globals.window = saved.window
})

function installDom(coarse = false) {
  const listeners = new Map<string, Set<Listener>>()
  globals.document = {
    addEventListener: (type: string, fn: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(fn)
    },
    removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
  }
  globals.window = { matchMedia: (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }) }
  return {
    key: (key: string) =>
      act(() => {
        for (const fn of listeners.get('keydown') ?? []) fn({ key })
      }),
  }
}

function render(overrides: Partial<Props> = {}, options: { focusCalls?: string[] } = {}) {
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
    renderer = TestRenderer.create(<SessionFilterButton {...props} />, {
      createNodeMock: (element) =>
        element.type === 'input' && element.props.type === 'search'
          ? { focus: () => options.focusCalls?.push('search') }
          : null,
    })
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
  const clear = () =>
    renderer.root.findAll((n) => n.type === 'button' && n.children.includes('Clear'))
  const header = () =>
    renderer.root.find((n) => n.type === 'div' && n.props['data-testid'] === 'filter-header')
  const search = () =>
    renderer.root.findAll((n) => n.type === 'input' && n.props.type === 'search')
  const type = (text: string) => act(() => search()[0].props.onChange({ target: { value: text } }))
  const allRows = () =>
    renderer.root.findAll((n) => n.type === 'label').map((label) =>
      label.findAll((n) => n.type === 'span')[0].children.join('')
    )
  const noMatches = () =>
    renderer.root.findAll((n) => n.type === 'div' && n.props['data-testid'] === 'filter-no-matches')
  const text = () =>
    renderer.root
      .findAll((n) => typeof n.type === 'string')
      .flatMap((n) => n.children.filter((c): c is string => typeof c === 'string'))
      .join(' ')
  const scroller = () =>
    renderer.root.find((n) => n.type === 'div' && n.props['data-testid'] === 'filter-options')
  const badge = () => renderer.root.findAll((n) => n.props['data-testid'] === 'filter-count-badge')
  const dot = () => renderer.root.findAll((n) => n.type === 'button' && n.props['data-testid'] === 'hidden-attention-dot')
  return { renderer, calls, trigger, open, menu, groups, groupHeading, rowsOf, clear, header, search, type, allRows, noMatches, text, scroller, badge, dot }
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
    // No "All hosts"/"All projects" rows: one row per option only.
    expect(hostRows.map((row) => row.text)).toEqual(['local', 'devbox offline'])
    expect(hostRows[0].input.props.checked).toBe(false)
    expect(hostRows[1].input.props.checked).toBe(true)
    expect(hostRows[1].title).toBe('devbox: ssh timeout')
    const projectRows = r.rowsOf(groups[1])
    expect(projectRows.map((row) => row.text)).toEqual(['alpha', 'work/bravo', 'other/bravo'])
    expect(projectRows.every((row) => row.input.props.checked === false)).toBe(true)
    expect(projectRows[0].title).toBe('/work/alpha')
    act(() => r.renderer.unmount())
  })

  test('no Hosts section without remote hosts', () => {
    const r = render({ showHosts: false })
    r.open()
    expect(r.groups().map(r.groupHeading)).toEqual(['Projects'])
    act(() => r.renderer.unmount())
  })

  test('checklists toggle in list order; unticking the last one means no filter', () => {
    const r = render({ showHosts: true, selectedProjects: ['/other/bravo'] })
    r.open()
    const [hostGroup, projectGroup] = r.groups()
    act(() => r.rowsOf(projectGroup)[0].input.props.onChange())
    expect(r.calls.projects).toEqual([['/work/alpha', '/other/bravo']])
    act(() => r.rowsOf(projectGroup)[2].input.props.onChange())
    expect(r.calls.projects[1]).toEqual([])
    act(() => r.rowsOf(hostGroup)[1].input.props.onChange())
    expect(r.calls.hosts).toEqual([['devbox']])
    act(() => r.renderer.unmount())
  })

  test('no hint or summary text: the menu is a plain checklist', () => {
    for (const overrides of [{}, { selectedProjects: ['/work/alpha'], selectedHosts: ['local'] }]) {
      const r = render({ showHosts: true, ...overrides })
      r.open()
      const text = r.text()
      expect(text).not.toContain('Showing all')
      expect(text).not.toContain('Tick to narrow')
      expect(text).not.toContain('selected')
      expect(text).not.toContain('Show all')
      expect(r.renderer.root.findAll((n) => n.props['data-testid'] === 'filter-summary')).toHaveLength(0)
      expect(r.menu()[0].props['aria-describedby']).toBeUndefined()
      act(() => r.renderer.unmount())
    }
  })

  test('header row is always there; Clear only while a filter is active', () => {
    const idle = render({ showHosts: true })
    idle.open()
    expect(idle.header().children.length).toBeGreaterThan(0)
    expect(idle.text()).toContain('Filter')
    expect(idle.clear()).toHaveLength(0)
    // Same header height with and without Clear, so the rows never jump.
    const idleHeader = idle.header().props.className as string
    expect(idleHeader).toContain('shrink-0')
    expect(idleHeader).toContain('h-[26px]')
    expect(idleHeader).toContain('[@media(pointer:coarse)]:h-[44px]')
    act(() => idle.renderer.unmount())

    const r = render({ showHosts: true, selectedProjects: ['/work/alpha'], selectedHosts: ['local'] })
    r.open()
    expect(r.header().props.className).toBe(idleHeader)
    const [clear] = r.clear()
    expect(clear).toBeDefined()
    expect(clear.props.role).toBe('menuitem')
    expect(clear.props.type).toBe('button')
    expect(clear.props.disabled).toBeUndefined()
    // In the header, after the title (right-aligned by justify-between).
    expect(r.header().findAll((n) => n === clear)).toHaveLength(1)
    expect(r.header().props.className).toContain('justify-between')
    // Fills the row: 44px tall and at least 44px wide on coarse pointers.
    expect(clear.props.className).toContain('h-full')
    expect(clear.props.className).toContain('[@media(pointer:coarse)]:min-w-[44px]')
    expect(clear.props.className).toContain('focus-visible:ring-2')
    act(() => clear.props.onClick())
    expect(r.calls.projects).toEqual([[]])
    expect(r.calls.hosts).toEqual([[]])
    act(() => r.renderer.unmount())
  })

  test('Clear shows for a host-only filter too', () => {
    const r = render({ showHosts: true, selectedHosts: ['devbox'] })
    r.open()
    expect(r.clear()).toHaveLength(1)
    act(() => r.renderer.unmount())
  })

  test('search field only past the threshold (hosts count when shown)', () => {
    expect(FILTER_SEARCH_THRESHOLD).toBe(8)
    const few = render()
    few.open()
    expect(few.search()).toHaveLength(0)
    act(() => few.renderer.unmount())

    const many = render({ projects: manyProjects })
    many.open()
    expect(many.search()).toHaveLength(1)
    expect(many.search()[0].props['aria-label']).toBe('Search filters')
    // Pinned: a sibling of the scroll region, not inside it.
    expect(many.scroller().findAll((n) => n.type === 'input' && n.props.type === 'search')).toHaveLength(0)
    act(() => many.renderer.unmount())

    const edge = Array.from({ length: 7 }, (_, i) => `/e/p${i}`)
    // 7 projects + 2 hosts = 9 > 8, but only while the Hosts section shows.
    const withHosts = render({ projects: edge, showHosts: true })
    withHosts.open()
    expect(withHosts.search()).toHaveLength(1)
    act(() => withHosts.renderer.unmount())
    const noHosts = render({ projects: edge, showHosts: false })
    noHosts.open()
    expect(noHosts.search()).toHaveLength(0)
    act(() => noHosts.renderer.unmount())
  })

  test('typing narrows rows by a case-insensitive substring of the label', () => {
    const r = render({ projects: manyProjects })
    r.open()
    expect(r.allRows()).toHaveLength(30)
    r.type('P2')
    expect(r.allRows()).toEqual(['p20', 'p21', 'p22', 'p23', 'p24', 'p25', 'p26', 'p27', 'p28', 'p29'])
    r.type('  p0  ')
    expect(r.allRows()).toHaveLength(10)
    r.type('')
    expect(r.allRows()).toHaveLength(30)
    act(() => r.renderer.unmount())
  })

  test('typed text is plain text, never a pattern', () => {
    expect(matchesFilterQuery('a.b', '.')).toBe(true)
    expect(matchesFilterQuery('ab', '.')).toBe(false)
    expect(matchesFilterQuery('x(y', '(')).toBe(true)
    expect(matchesFilterQuery('anything', '.*')).toBe(false)
    expect(matchesFilterQuery('Alpha', 'ALP')).toBe(true)
    expect(matchesFilterQuery('Alpha', '   ')).toBe(true)
  })

  test('ticked rows stay visible when they do not match; toggling keeps list order', () => {
    const r = render({ projects: manyProjects, selectedProjects: ['/work/p03'] })
    r.open()
    r.type('p1')
    expect(r.allRows()).toEqual(['p03', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18', 'p19'])
    const [group] = r.groups()
    // Ticking a visible row reports the full selection, hidden ones included.
    act(() => r.rowsOf(group)[1].input.props.onChange())
    expect(r.calls.projects).toEqual([['/work/p03', '/work/p10']])
    act(() => r.renderer.unmount())
  })

  test('matching hosts and projects: sections without matches drop out; none shows "No matches"', () => {
    const hostList = ['local', 'devbox', 'gpu-a', 'gpu-b']
    const r = render({ projects: manyProjects, hosts: hostList, showHosts: true })
    r.open()
    r.type('gpu')
    expect(r.groups().map(r.groupHeading)).toEqual(['Hosts'])
    expect(r.allRows()).toEqual(['gpu-a', 'gpu-b'])
    expect(r.noMatches()).toHaveLength(0)
    r.type('zz')
    expect(r.groups()).toHaveLength(0)
    expect(r.noMatches()).toHaveLength(1)
    expect(r.noMatches()[0].children).toEqual(['No matches'])
    act(() => r.renderer.unmount())
  })

  test('a ticked row keeps its section visible even when nothing else matches', () => {
    const r = render({ projects: manyProjects, selectedProjects: ['/work/p05'] })
    r.open()
    r.type('zz')
    expect(r.allRows()).toEqual(['p05'])
    expect(r.noMatches()).toHaveLength(0)
    act(() => r.renderer.unmount())
  })

  test('Escape clears the search first, then closes; reopening starts empty', () => {
    const dom = installDom()
    const r = render({ projects: manyProjects })
    r.open()
    r.type('p1')
    expect(r.allRows()).toHaveLength(10)
    dom.key('Escape')
    expect(r.menu()).toHaveLength(1)
    expect(r.search()[0].props.value).toBe('')
    expect(r.allRows()).toHaveLength(30)
    dom.key('Escape')
    expect(r.menu()).toHaveLength(0)
    r.open()
    r.type('p2')
    // Closing from the trigger also drops the text.
    act(() => r.trigger().props.onClick())
    r.open()
    expect(r.search()[0].props.value).toBe('')
    act(() => r.renderer.unmount())
  })

  test('Escape without search text closes at once', () => {
    const dom = installDom()
    const r = render()
    r.open()
    dom.key('a')
    expect(r.menu()).toHaveLength(1)
    dom.key('Escape')
    expect(r.menu()).toHaveLength(0)
    act(() => r.renderer.unmount())
  })

  test('the search takes focus on open with a fine pointer, not on touch', () => {
    installDom(false)
    const desktop: string[] = []
    const d = render({ projects: manyProjects }, { focusCalls: desktop })
    d.open()
    expect(desktop).toEqual(['search'])
    act(() => d.renderer.unmount())

    installDom(true)
    const touch: string[] = []
    const t = render({ projects: manyProjects }, { focusCalls: touch })
    t.open()
    expect(touch).toEqual([])
    act(() => t.renderer.unmount())
  })

  test('search input is 16px on touch devices (no iOS zoom)', () => {
    const r = render({ projects: manyProjects })
    r.open()
    expect(r.search()[0].props.className).toContain('[@media(pointer:coarse)]:text-[16px]')
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

  test('menu spans the filter bar; only the checklists scroll', () => {
    const r = render({ selectedProjects: ['/work/alpha'] })
    r.open()
    const cls = r.menu()[0].props.className as string
    expect(cls).toContain('left-2 right-2')
    expect(cls).toMatch(/max-h-\[min\(/)
    expect(cls).toContain('overflow-hidden')
    expect(cls).not.toContain('overflow-y-auto')
    // The checklists live in the one scroll region; the header (and Clear)
    // are its siblings, so they stay pinned.
    const scrollCls = r.scroller().props.className as string
    expect(scrollCls).toContain('overflow-y-auto')
    expect(scrollCls).toContain('min-h-0')
    expect(r.scroller().findAll((n) => n.type === 'div' && n.props.role === 'group')).toHaveLength(1)
    expect(r.scroller().findAll((n) => n.props['data-testid'] === 'filter-header')).toHaveLength(0)
    expect(r.scroller().findAll((n) => n.type === 'button')).toHaveLength(0)
    expect(r.header().props.className).toContain('shrink-0')
    // The wrapper must not be the containing block, or the menu would size
    // to the 28px button instead of the bar.
    const wrapper = r.renderer.root.findByProps({ className: 'flex shrink-0' })
    expect(wrapper.props.className).not.toContain('relative')
    act(() => r.renderer.unmount())
  })
})
