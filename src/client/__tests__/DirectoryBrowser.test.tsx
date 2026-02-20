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

function createFetchController(responses: Response[], calls: string[] = []) {
  const pending: Array<(value: Response) => void> = []
  const fetchImpl = (input: RequestInfo | URL) => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    calls.push(url)
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

  test('renders mapped not-found error state with retry', async () => {
    const listing = makeListing({
      directories: [{ name: 'alpha', path: '/root/alpha' }],
    })
    const controller = createFetchController([
      createJsonResponse(
        { error: 'not_found', message: 'Path does not exist' },
        { status: 404 }
      ),
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
      expect(error.findByType('p').children.join('')).toBe(
        'Directory not found. Check the path and try again.'
      )

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

  test('renders mapped forbidden error state', async () => {
    const controller = createFetchController([
      createJsonResponse(
        { error: 'forbidden', message: 'Permission denied' },
        { status: 403 }
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
      const error = renderer.root.findByProps({
        'data-testid': 'directory-error',
      })
      expect(error.findByType('p').children.join('')).toBe(
        'You do not have permission to open this directory. Choose another folder.'
      )
    } finally {
      await cleanup(renderer)
    }
  })

  test('renders mapped network error state', async () => {
    globalAny.fetch = (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch

    const renderer = await createBrowser(
      <DirectoryBrowser
        initialPath="/root"
        onSelect={() => {}}
        onCancel={() => {}}
      />
    )

    try {
      await flushBrowser()
      const error = renderer.root.findByProps({
        'data-testid': 'directory-error',
      })
      expect(error.findByType('p').children.join('')).toBe(
        'Could not reach the server. Check your connection and try again.'
      )
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
      expect(controller.calls[1]).toContain('path=%2Froot%2Fchild')
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
      expect(controller.calls[1]).toContain('path=%2Froot%2Falpha')
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

      expect(controller.calls[1]).toContain('path=%2Ftwo')
    } finally {
      await cleanup(renderer)
    }
  })
})
