import { afterAll, describe, expect, test, mock } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { Session } from '@shared/types'

const globalAny = globalThis as typeof globalThis & {
  localStorage?: Storage
}

const originalLocalStorage = globalAny.localStorage

function createStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

globalAny.localStorage = createStorage()

mock.module('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    buffer = { active: { viewportY: 0, baseY: 0 } }
    element: HTMLElement | null = null
    loadAddon() {}
    open() {}
    reset() {}
    onData() {}
    onScroll() {}
    attachCustomKeyEventHandler() { return true }
    write() {}
    scrollToBottom() {}
    hasSelection() { return false }
    getSelection() { return '' }
    dispose() {}
  },
}))
mock.module('@xterm/addon-fit', () => ({
  FitAddon: class { fit() {} },
}))
mock.module('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class {},
}))
mock.module('@xterm/addon-webgl', () => ({
  WebglAddon: class { dispose() {} },
}))
mock.module('@xterm/addon-search', () => ({
  SearchAddon: class {},
}))
mock.module('@xterm/addon-serialize', () => ({
  SerializeAddon: class {},
}))
mock.module('@xterm/addon-progress', () => ({
  ProgressAddon: class {},
}))
mock.module('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {},
}))

const [{ default: App }, { default: Header }, { default: SessionList }, { default: Terminal }, { default: TerminalControls }, { default: NewSessionModal }, { default: SettingsModal }, { default: DPad }, { default: NumPad }] =
  await Promise.all([
    import('../App'),
    import('../components/Header'),
    import('../components/SessionList'),
    import('../components/Terminal'),
    import('../components/TerminalControls'),
    import('../components/NewSessionModal'),
    import('../components/SettingsModal'),
    import('../components/DPad'),
    import('../components/NumPad'),
  ])

const baseSession: Session = {
  id: 'session-1',
  name: 'alpha',
  tmuxWindow: 'agentboard:1',
  projectPath: '/tmp/alpha',
  status: 'working',
  lastActivity: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  source: 'managed',
}

describe('component rendering', () => {
  test('renders app shell', () => {
    const html = renderToString(<App />)
    expect(html).toContain('AGENTBOARD')
  })

  test('renders header', () => {
    const html = renderToString(
      <Header connectionStatus="connected" onNewSession={() => {}} tailscaleIp={null} />
    )
    expect(html).toContain('AGENTBOARD')
  })

  test('renders session list', () => {
    const html = renderToString(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId="session-1"
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(html).toContain('Sessions')
    expect(html).toContain('alpha')
  })

  test('renders session list loading and empty states', () => {
    const loadingHtml = renderToString(
      <SessionList
        sessions={[]}
        selectedSessionId={null}
        loading
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(loadingHtml).toContain('animate-pulse')

    const emptyHtml = renderToString(
      <SessionList
        sessions={[]}
        selectedSessionId={null}
        loading={false}
        error={null}
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(emptyHtml).toContain('No sessions')
  })

  test('renders session list error state', () => {
    const html = renderToString(
      <SessionList
        sessions={[baseSession]}
        selectedSessionId={baseSession.id}
        loading={false}
        error="Oops"
        onSelect={() => {}}
        onRename={() => {}}
      />
    )
    expect(html).toContain('Oops')
  })

  test('renders terminal', () => {
    const html = renderToString(
      <Terminal
        session={baseSession}
        sessions={[baseSession]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('alpha')
  })

  test('renders terminal placeholder when no session selected', () => {
    const html = renderToString(
      <Terminal
        session={null}
        sessions={[]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('Select a session to view terminal')
  })

  test('renders terminal mobile switcher for multiple sessions', () => {
    const secondSession = {
      ...baseSession,
      id: 'session-2',
      name: 'beta',
      status: 'waiting' as const,
    }

    const html = renderToString(
      <Terminal
        session={baseSession}
        sessions={[baseSession, secondSession]}
        connectionStatus="connected"
        sendMessage={() => {}}
        subscribe={() => () => {}}
        onClose={() => {}}
        onSelectSession={() => {}}
        onNewSession={() => {}}
        onKillSession={() => {}}
        onRenameSession={() => {}}
        onOpenSettings={() => {}}
      />
    )
    expect(html).toContain('scroll-smooth')
  })

  test('renders terminal controls', () => {
    const html = renderToString(
      <TerminalControls
        onSendKey={() => {}}
        sessions={[{ id: 'session-1', name: 'alpha', status: 'working' }]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )
    expect(html).toContain('terminal-controls')
  })

  test('renders terminal controls session row when multiple sessions', () => {
    const html = renderToString(
      <TerminalControls
        onSendKey={() => {}}
        sessions={[
          { id: 'session-1', name: 'alpha', status: 'working' },
          { id: 'session-2', name: 'beta', status: 'waiting' },
        ]}
        currentSessionId="session-1"
        onSelectSession={() => {}}
      />
    )
    expect(html).toContain('snap-mandatory')
  })

  test('renders new session modal', () => {
    const html = renderToString(
      <NewSessionModal
        isOpen
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/tmp"
        commandPresets={[
          { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
          { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
        ]}
        defaultPresetId="claude"
        onUpdateModifiers={() => {}}
        lastProjectPath="/tmp/alpha"
        activeProjectPath="/tmp/alpha"
      />
    )
    expect(html).toContain('New Session')
  })

  test('does not render new session modal when closed', () => {
    const html = renderToString(
      <NewSessionModal
        isOpen={false}
        onClose={() => {}}
        onCreate={() => {}}
        defaultProjectDir="/tmp"
        commandPresets={[
          { id: 'claude', label: 'Claude', baseCommand: 'claude', modifiers: '', isBuiltIn: true, agentType: 'claude' },
          { id: 'codex', label: 'Codex', baseCommand: 'codex', modifiers: '', isBuiltIn: true, agentType: 'codex' },
        ]}
        defaultPresetId="claude"
        onUpdateModifiers={() => {}}
        lastProjectPath="/tmp/alpha"
        activeProjectPath="/tmp/alpha"
      />
    )
    expect(html).toBe('')
  })

  test('renders settings modal', () => {
    const html = renderToString(
      <SettingsModal isOpen onClose={() => {}} />
    )
    expect(html).toContain('Settings')
  })

  test('renders controls widgets', () => {
    const dpad = renderToString(<DPad onSendKey={() => {}} />)
    const numpad = renderToString(<NumPad onSendKey={() => {}} />)
    expect(dpad).toContain('terminal-key')
    expect(numpad).toContain('terminal-key')
  })
})

afterAll(() => {
  globalAny.localStorage = originalLocalStorage
})
