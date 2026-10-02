/**
 * Shared fixtures for the settings dialog tests: in-memory storage, a fake
 * settings API, store reset, and finders for dialog parts.
 */
import { afterEach, beforeEach } from 'bun:test'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import SettingsModal from '../components/SettingsModal'
import { Switch } from '../components/Switch'
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  useSettingsStore,
} from '../stores/settingsStore'
import { useThemeStore } from '../stores/themeStore'

export const globalAny = globalThis as unknown as {
  localStorage?: Storage
  window?: unknown
}

const originalLocalStorage = globalAny.localStorage
const originalWindow = globalAny.window
const originalFetch = globalThis.fetch

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
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

export interface FetchCall {
  url: string
  method: string
  body: string | null
}

/** Every fetch the dialog made in the current test. */
export const fetchCalls: FetchCall[] = []
const mounted: TestRenderer.ReactTestRenderer[] = []
let serverValues: Record<string, unknown> = {}

export function installFetch(handler?: (call: FetchCall) => Response | Promise<Response> | undefined) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    }
    fetchCalls.push(call)
    const custom = handler?.(call)
    if (custom) return custom
    const name = call.url.replace('/api/settings/', '')
    const payload = name === 'history-max-age-hours'
      ? { hours: serverValues[name] ?? 24 }
      : { enabled: serverValues[name] ?? true }
    return new Response(JSON.stringify(payload), { status: 200 })
  }) as typeof fetch
}

export function setPhone(isPhone: boolean) {
  globalAny.window = {
    matchMedia: () => ({
      matches: isPhone,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  }
}

/** Installs storage/fetch/store fixtures around every test in the file. */
export function setupSettingsDialogTests() {
beforeEach(() => {
  globalAny.localStorage = createStorage()
  fetchCalls.length = 0
  serverValues = {}
  installFetch()
  useSettingsStore.setState({
    defaultProjectDir: '/projects',
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'codex',
    sessionSortMode: 'created',
    sessionSortDirection: 'desc',
    sidebarAnchor: 'top',
    showProjectName: true,
    showLastUserMessage: true,
    showSessionIdPrefix: false,
    useWebGL: true,
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
    fontOption: 'jetbrains-mono',
    customFontFamily: '',
    shortcutModifier: 'auto',
    soundOnPermission: false,
    soundOnIdle: false,
  })
  useThemeStore.setState({ theme: 'dark' })
})

afterEach(() => {
  act(() => {
    for (const renderer of mounted.splice(0)) renderer.unmount()
  })
  globalAny.localStorage = originalLocalStorage
  globalAny.window = originalWindow
  globalThis.fetch = originalFetch
  useSettingsStore.setState({
    defaultProjectDir: DEFAULT_PROJECT_DIR,
    commandPresets: DEFAULT_PRESETS,
    defaultPresetId: 'claude',
  })
})
}

export async function render(props: { isOpen?: boolean; onClose?: () => void } = {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <SettingsModal isOpen={props.isOpen ?? true} onClose={props.onClose ?? (() => {})} />
    )
    await Promise.resolve()
  })
  mounted.push(renderer)
  // Let server-setting fetches resolve.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return renderer
}

export function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  return node.children.map((child) => textOf(child as ReactTestInstance | string)).join('')
}

export const byRole = (root: ReactTestInstance, role: string) =>
  root.findAll((node) => typeof node.type === 'string' && node.props.role === role)

export function tab(root: ReactTestInstance, label: string) {
  const found = byRole(root, 'tab').find((node) => node.props.children === label)
  if (!found) throw new Error(`Expected tab ${label}`)
  return found
}

export function radio(root: ReactTestInstance, label: string) {
  const found = byRole(root, 'radio').find((node) => node.props.children === label)
  if (!found) throw new Error(`Expected radio ${label}`)
  return found
}

export function row(root: ReactTestInstance, id: string) {
  const found = root.findAll((node) => node.props['data-setting-row'] === id)
  if (found.length === 0) throw new Error(`Expected row ${id}`)
  return found[0]
}

export function rowSwitch(root: ReactTestInstance, id: string) {
  return row(root, id).findByType(Switch)
}

export async function openPage(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => {
    tab(renderer.root, label).props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export const searchInput = (root: ReactTestInstance) => root.find((node) => node.props.id === 'settings-search')

