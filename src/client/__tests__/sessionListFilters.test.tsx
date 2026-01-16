import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { Session } from '@shared/types'
import ProjectFilterDropdown from '../components/ProjectFilterDropdown'
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
    inactiveSessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
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
    inactiveSessionsExpanded: false,
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    projectFilters: [],
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
    useSettingsStore.setState({ projectFilters: ['/tmp/visible'] })

    const sessions: Session[] = [
      { ...baseSession, id: 'visible', projectPath: '/tmp/visible', status: 'working' },
      { ...baseSession, id: 'hidden', projectPath: '/tmp/hidden', status: 'permission' },
    ]

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <SessionList
          sessions={sessions}
          inactiveSessions={[]}
          selectedSessionId={null}
          loading={false}
          error={null}
          onSelect={() => {}}
          onRename={() => {}}
        />
      )
    })

    const dropdown = renderer.root.findByType(ProjectFilterDropdown)
    expect(dropdown.props.selectedProjects).toEqual(['/tmp/visible'])
    expect(dropdown.props.projects).toEqual(
      expect.arrayContaining(['/tmp/visible', '/tmp/hidden'])
    )
    expect(dropdown.props.hasHiddenPermissions).toBe(true)

    act(() => {
      renderer.unmount()
    })
  })
})
