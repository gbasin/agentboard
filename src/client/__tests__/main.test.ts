import { afterAll, describe, expect, test, mock } from 'bun:test'

const globalAny = globalThis as typeof globalThis & {
  document?: Document
  localStorage?: Storage
}

const originalDocument = globalAny.document
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

const renderCalls: Array<{ element: Element; node: unknown }> = []

mock.module('react-dom/client', () => ({
  createRoot: (element: Element) => ({
    render: (node: unknown) => {
      renderCalls.push({ element, node })
    },
  }),
}))
mock.module('@xterm/xterm', () => ({ Terminal: class {} }))
mock.module('@xterm/addon-fit', () => ({ FitAddon: class {} }))
mock.module('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
mock.module('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
mock.module('@xterm/addon-search', () => ({ SearchAddon: class {} }))
mock.module('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }))
mock.module('@xterm/addon-progress', () => ({ ProgressAddon: class {} }))
mock.module('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
mock.module('@xterm/xterm/css/xterm.css', () => ({}))
mock.module('virtual:pwa-register', () => ({
  registerSW: () => () => {},
}))

const stylesPath = new URL('../styles/index.css', import.meta.url).pathname
mock.module(stylesPath, () => ({}))

globalAny.localStorage = createStorage()
globalAny.document = {
  getElementById: (id: string) => (id === 'root' ? ({ id } as HTMLElement) : null),
} as unknown as Document

describe('main entrypoint', () => {
  test('mounts the app', async () => {
    await import('../main')
    expect(renderCalls).toHaveLength(1)
    expect(renderCalls[0]?.element?.id).toBe('root')
  })
})

afterAll(() => {
  globalAny.document = originalDocument
  globalAny.localStorage = originalLocalStorage
})
