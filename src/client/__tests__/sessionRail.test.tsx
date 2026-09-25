import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentSession, Session } from '@shared/types'
import SessionRail from '../components/SessionRail'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  window?: Window & typeof globalThis
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document

let copiedText = ''
const renderers: TestRenderer.ReactTestRenderer[] = []

const liveSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: '2024-01-01T00:00:00.000Z',
  createdAt: '2024-01-01T00:00:00.000Z',
  source: 'managed',
  agentSessionId: 'abcdef1234567890',
  logFilePath: '/tmp/alpha.jsonl',
}

const hibernatingSession: AgentSession = {
  sessionId: 'hibernating-1',
  logFilePath: '/tmp/hibernating-1.jsonl',
  projectPath: '/tmp/alpha',
  agentType: 'claude',
  displayName: 'alpha-hibernating',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-01T00:00:00.000Z',
  isActive: false,
  isHibernating: true,
}

function railProps(overrides: Record<string, unknown> = {}) {
  return {
    session: liveSession as Session | null,
    hibernatingSession: null as AgentSession | null,
    hibernatingDisplayName: '',
    showHostBadge: false,
    sessionCount: 1,
    connectionStatus: 'connected' as const,
    isSwitching: false,
    canControl: true,
    canHibernate: true,
    modDisplay: '⌘',
    onKill: mock(() => {}),
    onHibernate: mock(() => {}),
    onWake: mock(() => {}),
    onRename: mock((_name: string) => {}),
    onDuplicate: mock(() => {}),
    onMoveToHistory: mock(() => {}),
    isTmuxCopyMode: false,
    showJumpToBottom: false,
    onJumpToBottom: mock(() => {}),
    selectionReady: false,
    onCopySelection: mock(() => {}),
    onDismissSelection: mock(() => {}),
    ...overrides,
  }
}

function render(props: ReturnType<typeof railProps>) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<SessionRail {...props} />)
  })
  renderers.push(renderer)
  return renderer
}

/** Flatten props.children to its text leaves (icon elements are objects). */
function textLeaves(children: unknown): string[] {
  if (typeof children === 'string' || typeof children === 'number') {
    return [String(children)]
  }
  if (Array.isArray(children)) return children.flatMap(textLeaves)
  return []
}

function menuButton(root: TestRenderer.ReactTestInstance, label: string) {
  return root
    .findAllByType('button')
    .find((button) => textLeaves(button.props.children).includes(label))
}

function openRailMenu(root: TestRenderer.ReactTestInstance) {
  const identity = root
    .findAllByType('div')
    .find((div) => typeof div.props.onContextMenu === 'function')
  act(() => {
    identity!.props.onContextMenu({
      preventDefault() {},
      stopPropagation() {},
      clientX: 40,
      clientY: 500,
    })
  })
}

beforeEach(() => {
  copiedText = ''
  globalAny.document = {
    createElement: () => ({
      value: '',
      style: {},
      focus() {},
      select() {},
    }),
    body: {
      appendChild(el: { value: string }) {
        copiedText = el.value
      },
      removeChild() {},
    },
    execCommand: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Document

  useSettingsStore.setState({
    showProjectName: true,
    showSessionIdPrefix: true,
  })
})

afterEach(() => {
  // Unmount while the document stub is still in place — ContextMenu's
  // dismiss listeners detach on unmount.
  for (const renderer of renderers.splice(0)) {
    act(() => renderer.unmount())
  }
  globalAny.window = originalWindow
  globalAny.document = originalDocument
  useSettingsStore.setState({
    showProjectName: true,
    showSessionIdPrefix: false,
  })
})

describe('SessionRail', () => {
  test('renders session name, status, and id prefix in a 40px rail', () => {
    const renderer = render(railProps())

    const footer = renderer.root.findByType('footer')
    expect(footer.props.className).toContain('h-10')
    expect(footer.props.className).toContain('px-4')

    const name = renderer.root
      .findAllByType('span')
      .find((span) => span.props.children === 'alpha')
    expect(name).toBeDefined()
    expect(name!.props.className).toContain('text-sm')

    const idButton = renderer.root.findByProps({
      'aria-label': 'Copy session ID',
    })
    expect(idButton.props.children).toBe('abc…890')
  })

  test('clicking the session id copies the full agentSessionId', () => {
    const renderer = render(railProps())

    const idButton = renderer.root.findByProps({
      'aria-label': 'Copy session ID',
    })
    act(() => {
      idButton.props.onClick()
    })

    expect(copiedText).toBe('abcdef1234567890')
    expect(
      renderer.root.findByProps({ 'aria-label': 'Copy session ID' }).props
        .children
    ).toBe('Copied!')
  })

  test('right-click on the identity group opens the session context menu', () => {
    const onKill = mock(() => {})
    const onDuplicate = mock(() => {})
    const renderer = render(railProps({ onKill, onDuplicate }))

    openRailMenu(renderer.root)

    for (const label of [
      'Rename',
      'Duplicate',
      'Hibernate',
      'Copy Session ID',
      'Copy Log Path',
      'Kill Session',
    ]) {
      expect(menuButton(renderer.root, label)).toBeDefined()
    }

    // Menu opens above the rail (viewport bottom)
    const menu = renderer.root.findByProps({ role: 'menu' })
    expect(String(menu.props.style.transform)).toContain('calc(-100% - 6px)')

    act(() => {
      menuButton(renderer.root, 'Kill Session')!.props.onClick({
        stopPropagation() {},
      })
    })
    expect(onKill).toHaveBeenCalledTimes(1)
  })

  test('Rename menu item swaps the name for an inline input', () => {
    const onRename = mock((_name: string) => {})
    const renderer = render(railProps({ onRename }))

    openRailMenu(renderer.root)
    act(() => {
      menuButton(renderer.root, 'Rename')!.props.onClick({
        stopPropagation() {},
      })
    })

    const input = renderer.root.findByProps({ 'aria-label': 'Rename session' })
    expect(input.props.value).toBe('alpha')

    act(() => {
      input.props.onChange({ target: { value: 'renamed-session' } })
    })
    act(() => {
      input.props.onKeyDown({ key: 'Enter', preventDefault() {} })
    })

    expect(onRename).toHaveBeenCalledWith('renamed-session')
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Rename session' })
    ).toHaveLength(0)
  })

  test('hibernating variant gets Wake/Rename/Copy/Move to History menu', () => {
    const onWake = mock(() => {})
    const onMoveToHistory = mock(() => {})
    const renderer = render(
      railProps({
        session: null,
        hibernatingSession,
        hibernatingDisplayName: 'alpha-hibernating',
        onWake,
        onMoveToHistory,
      })
    )

    openRailMenu(renderer.root)

    for (const label of [
      'Wake',
      'Rename',
      'Copy Session ID',
      'Copy Log Path',
      'Move to History',
    ]) {
      expect(menuButton(renderer.root, label)).toBeDefined()
    }
    expect(menuButton(renderer.root, 'Kill Session')).toBeUndefined()
    expect(menuButton(renderer.root, 'Duplicate')).toBeUndefined()

    act(() => {
      menuButton(renderer.root, 'Move to History')!.props.onClick({
        stopPropagation() {},
      })
    })
    expect(onMoveToHistory).toHaveBeenCalledTimes(1)
  })

  test('empty state shows the session count', () => {
    const renderer = render(railProps({ session: null, sessionCount: 4 }))

    const count = renderer.root
      .findAllByType('span')
      .find((span) => textLeaves(span.props.children).join('') === '4 sessions')
    expect(count).toBeDefined()
    expect(count!.props.className).toContain('text-xs')
  })
})
