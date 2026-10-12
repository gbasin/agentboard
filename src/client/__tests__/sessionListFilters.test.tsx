import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import SessionFilterButton from '../components/SessionFilterButton'
import SessionList from '../components/SessionList'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
}

const originalWindow = globalAny.window

beforeEach(() => {
  globalAny.window = {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  } as unknown as Window & typeof globalThis

  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    manualSessionOrder: [],
    historySessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })

  useSessionStore.setState({
    exitingSessions: new Map(),
  })
})

afterEach(() => {
  globalAny.window = originalWindow
  useSettingsStore.setState({
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    manualSessionOrder: [],
    historySessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
    hostFilters: [],
  })
  useSessionStore.setState({
    exitingSessions: new Map(),
  })
})

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
}

describe('SessionList project filters', () => {
  test('marks hidden permission sessions when filters exclude them', () => {
    useSettingsStore.setState({ projectFilters: ['/tmp/visible'], hostFilters: [] })

    const sessions: Session[] = [
      { ...baseSession, id: 'visible', projectPath: '/tmp/visible', status: 'working' },
      { ...baseSession, id: 'hidden', projectPath: '/tmp/hidden', status: 'permission' },
    ]

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={sessions}
          historySessions={[]}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })

    const filter = renderer.root.findByType(SessionFilterButton)
    expect(filter.props.selectedProjects).toEqual(['/tmp/visible'])
    expect(filter.props.showHosts).toBe(false)
    expect(filter.props.projects).toEqual(
      expect.arrayContaining(['/tmp/visible', '/tmp/hidden'])
    )
    expect(filter.props.hasHiddenPermissions).toBe(true)

    act(() => {
      renderer.unmount()
    })
  })
})

test('sort menu shares settings, preserves manual order, and excludes the filter menu', () => {
  useSettingsStore.setState({ manualSessionOrder: [baseSession.id] })
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <SessionList sessions={[baseSession]} historySessions={[]} selectedSessionId={null}
        loading={false} error={null} onSelect={() => {}} onRename={() => {}} />
    )
  })
  const filter = () => renderer.root.findByType(SessionFilterButton)
  const sort = () => renderer.root.find((n) => n.type === 'button' && n.props['aria-label']?.startsWith('Sort:'))
  const select = (label: string) => {
    act(() => sort().props.onClick())
    const row = renderer.root.find((n) => n.type === 'button' && n.props.role === 'menuitemradio'
      && n.findAll((child) => child.type === 'span' && child.children.includes(label)).length > 0)
    act(() => row.props.onClick())
    expect(sort().props['aria-expanded']).toBe(false)
  }
  act(() => filter().props.onOpenChange(true))
  act(() => sort().props.onClick())
  expect(filter().props.open).toBe(false)
  expect(sort().props['aria-expanded']).toBe(true)
  act(() => filter().props.onOpenChange(true))
  expect(sort().props['aria-expanded']).toBe(false)
  select('Oldest first')
  expect(useSettingsStore.getState().sessionSortMode).toBe('created')
  expect(useSettingsStore.getState().sessionSortDirection).toBe('asc')
  select('Needs attention')
  expect(useSettingsStore.getState().sessionSortMode).toBe('status')
  select('Manual order')
  expect(useSettingsStore.getState().sessionSortMode).toBe('manual')
  select('Newest first')
  expect(useSettingsStore.getState().sessionSortDirection).toBe('desc')
  expect(useSettingsStore.getState().manualSessionOrder).toEqual([baseSession.id])
  act(() => { useSettingsStore.setState({ sessionSortMode: 'status' }) })
  expect(sort().props.title).toBe('Sort: Needs attention')
  act(() => renderer.unmount())
})
