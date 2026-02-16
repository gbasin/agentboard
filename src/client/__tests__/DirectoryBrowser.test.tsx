import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ReactElement } from 'react'
import type { DirectoryListing } from '@shared/types'
import { useSettingsStore } from '../stores/settingsStore'

const globalAny = globalThis as typeof globalThis & {
  fetch?: typeof fetch
  window?: Window & typeof globalThis
}

const originalFetch = globalAny.fetch
const originalWindow = globalAny.window
let DirectoryBrowser: typeof import('../components/DirectoryBrowser').DirectoryBrowser

let keyHandlers = new Map<string, EventListener>()

function setupWindow() {
  keyHandlers = new Map()
  globalAny.window = {
    addEventListener: (event: string, handler: EventListener) => {
      keyHandlers.set(event, handler)
    },
    removeEventListener: (event: string) => {
      keyHandlers.delete(event)
    },
  } as unknown as Window & typeof globalThis
}

function createJsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function flushUpdates() {
  await flushPromises()
  await flushPromises()
}

async function createBrowser(element: ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(element)
    await flushUpdates()
  })
  return renderer
}

async function flushBrowser() {
  await act(async () => {
    await flushUpdates()
  })
}

async function resolveAndFlush(controller: { resolveNext: () => void }) {
  await act(async () => {
    controller.resolveNext()
    await flushUpdates()
  })
}

async function cleanup(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount()
    await flushUpdates()
  })
}

interface DirectoryFetchCall {
  url: string
  directoryPath: string | null
}

function getHeaderValue(headers: HeadersInit | undefined, key: string): string | null {
  if (!headers) {
    return null
  }

  if (headers instanceof Headers) {
    return headers.get(key)
  }

  if (Array.isArray(headers)) {
    const match = headers.find(([name]) => name.toLowerCase() === key.toLowerCase())
    return match ? match[1] : null
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === key.toLowerCase()) {
      return String(value)
    }
  }
  return null
}

function createFetchController(responses: Response[], calls: DirectoryFetchCall[] = []) {
  const pending: Array<(value: Response) => void> = []
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    calls.push({
      url,
      directoryPath: getHeaderValue(init?.headers, 'x-directory-path'),
    })
    return new Promise<Response>((resolve) => {
      pending.push(resolve)
    })
  }
  globalAny.fetch = fetchImpl as unknown as typeof fetch

  const resolveNext = () => {
    const resolve = pending.shift()
    const response = responses.shift()
    if (!resolve || !response) {
      throw new Error('Unexpected fetch resolution')
    }
    resolve(response)
  }

  return { calls, resolveNext }
}

function makeListing(
  overrides: Partial<DirectoryListing> = {}
): DirectoryListing {
  return {
    path: '/root',
    parent: '/',
    directories: [],
    truncated: false,
    ...overrides,
  }
}

beforeEach(async () => {
  setupWindow()
  useSettingsStore.setState({ recentPaths: [] })

  if (!DirectoryBrowser) {
    DirectoryBrowser = (await import('../components/DirectoryBrowser')).DirectoryBrowser
  }
})

afterEach(() => {
  globalAny.fetch = originalFetch
  globalAny.window = originalWindow
  useSettingsStore.setState({ recentPaths: [] })
})

describe('DirectoryBrowser', () => {
  test('renders loading state', async () => {
    const controller = createFetchController([
      createJsonResponse(makeListing()),
    ])
    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      const loading = renderer.root.findByProps({
        'data-testid': 'directory-loading',
      })
      expect(loading).toBeTruthy()

      await resolveAndFlush(controller)
    } finally {
      await cleanup(renderer)
    }
  })

  test('renders directory list', async () => {
    const listing = makeListing({
      directories: [
        { name: 'alpha', path: '/root/alpha' },
        { name: 'beta', path: '/root/beta' },
      ],
    })
    const controller = createFetchController([createJsonResponse(listing)])
    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const entries = renderer.root.findAllByProps({
        'data-testid': 'directory-entry',
      })
      expect(entries.map((entry) => entry.props['data-entry-name'])).toEqual([
        'alpha',
        'beta',
      ])
    } finally {
      await cleanup(renderer)
    }
  })

  test('renders error state with retry', async () => {
    const listing = makeListing({
      directories: [{ name: 'alpha', path: '/root/alpha' }],
    })
    const controller = createFetchController([
      createJsonResponse({ message: 'Nope' }, { status: 404 }),
      createJsonResponse(listing),
    ])

    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const error = renderer.root.findByProps({
        'data-testid': 'directory-error',
      })
      expect(error.findByType('p').children.join('')).toContain('Nope')

      const retryButton = renderer.root.findAllByType('button')
        .find((button) => button.props.children === 'Retry')
      if (!retryButton) {
        throw new Error('Expected retry button')
      }

      await act(async () => {
        retryButton.props.onClick()
      })
      await resolveAndFlush(controller)

      expect(controller.calls).toHaveLength(2)
      const entries = renderer.root.findAllByProps({
        'data-testid': 'directory-entry',
      })
      expect(entries).toHaveLength(1)
    } finally {
      await cleanup(renderer)
    }
  })

  test('renders empty state', async () => {
    const controller = createFetchController([
      createJsonResponse(makeListing()),
    ])
    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const empty = renderer.root.findByProps({
        'data-testid': 'directory-empty',
      })
      expect(empty).toBeTruthy()
    } finally {
      await cleanup(renderer)
    }
  })

  test('navigation updates path on click', async () => {
    const controller = createFetchController([
      createJsonResponse(
        makeListing({
          directories: [{ name: 'child', path: '/root/child' }],
        })
      ),
      createJsonResponse(
        makeListing({ path: '/root/child', parent: '/root' })
      ),
    ])

    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const entry = renderer.root.findByProps({ 'data-entry-name': 'child' })

      await act(async () => {
        entry.props.onClick()
      })
      await resolveAndFlush(controller)

      const pathNode = renderer.root.findByProps({
        'data-testid': 'directory-current-path',
      })
      expect(pathNode.children.join('')).toBe('/root/child')
      expect(controller.calls[1]).toEqual({
        url: '/api/directories',
        directoryPath: '/root/child',
      })
    } finally {
      await cleanup(renderer)
    }
  })

  test('keyboard navigation triggers entry load', async () => {
    const controller = createFetchController([
      createJsonResponse(
        makeListing({
          directories: [
            { name: 'alpha', path: '/root/alpha' },
            { name: 'bravo', path: '/root/bravo' },
          ],
        })
      ),
      createJsonResponse(
        makeListing({ path: '/root/alpha', parent: '/root' })
      ),
    ])

    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const keyHandler = keyHandlers.get('keydown')
      if (!keyHandler) {
        throw new Error('Expected keydown handler')
      }

      const entries = renderer.root.findAllByProps({
        'data-testid': 'directory-entry',
      })
      expect(entries).toHaveLength(2)

      await act(async () => {
        keyHandler({ key: 'ArrowDown', preventDefault: () => {} } as KeyboardEvent)
      })
      await flushBrowser()

      const updatedHandler = keyHandlers.get('keydown') ?? keyHandler
      await act(async () => {
        updatedHandler({ key: 'Enter', preventDefault: () => {} } as KeyboardEvent)
      })
      await resolveAndFlush(controller)

      expect(controller.calls).toHaveLength(2)
      expect(controller.calls[1]).toEqual({
        url: '/api/directories',
        directoryPath: '/root/alpha',
      })
      const pathNode = renderer.root.findByProps({
        'data-testid': 'directory-current-path',
      })
      expect(pathNode.children.join('')).toBe('/root/alpha')
    } finally {
      await cleanup(renderer)
    }
  })

  test('recent paths display and navigate', async () => {
    useSettingsStore.setState({ recentPaths: ['/one', '/two'] })
    const controller = createFetchController([
      createJsonResponse(makeListing()),
      createJsonResponse(makeListing({ path: '/two', parent: '/' })),
    ])

    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )
    try {
      await resolveAndFlush(controller)

      const recentButtons = renderer.root.findAllByProps({
        'data-testid': 'directory-recent',
      })
      expect(recentButtons.map((btn) => btn.props['data-recent-path'])).toEqual([
        '/one',
        '/two',
      ])

      await act(async () => {
        recentButtons[1]?.props.onClick()
      })
      await resolveAndFlush(controller)

      expect(controller.calls[1]).toEqual({
        url: '/api/directories',
        directoryPath: '/two',
      })
    } finally {
      await cleanup(renderer)
    }
  })
})
