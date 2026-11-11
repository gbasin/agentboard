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
let ProjectPathInput: typeof import('../components/ProjectPathInput').ProjectPathInput

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

async function resolveAndFlush(controller: { resolveNext: () => void }) {
  await act(async () => {
    await flushUpdates()
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
    ProjectPathInput = (await import('../components/ProjectPathInput')).ProjectPathInput
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
      expect(controller.calls[1]).toContain('path=%2Froot%2Fchild')
    } finally {
      await cleanup(renderer)
    }
  })

  test('cannot choose a failed or unsubmitted path', async () => {
    const selected: string[] = []
    const controller = createFetchController([
      createJsonResponse(makeListing()),
      createJsonResponse({ message: 'Missing' }, { status: 404 }),
    ])
    const renderer = await createBrowser(<DirectoryBrowser initialPath="/root" onSelect={path => selected.push(path)} onCancel={() => {}} />)
    try {
      await resolveAndFlush(controller)
      const choose = () => renderer.root.findByProps({ 'data-testid': 'directory-choose' })
      expect(choose().props.disabled).toBe(false)
      await act(async () => renderer.root.findByProps({ 'aria-label': 'Directory path' }).props.onChange({ target: { value: '/missing' } }))
      expect(choose().props.disabled).toBe(true)
      await act(async () => renderer.root.findByProps({ 'aria-label': 'Directory path' }).props.onKeyDown({ key: 'Enter', preventDefault() {} }))
      expect(choose().props.disabled).toBe(true)
      await resolveAndFlush(controller)
      expect(choose().props.disabled).toBe(true)
      choose().props.onClick()
      expect(selected).toEqual([])
    } finally { await cleanup(renderer) }
  })

  test('late navigation cannot overwrite a newer folder', async () => {
    const controller = createFetchController([
      createJsonResponse(makeListing({ path: '/old' })),
      createJsonResponse(makeListing({ path: '/new' })),
    ])
    const renderer = await createBrowser(<DirectoryBrowser initialPath="/old" onSelect={() => {}} onCancel={() => {}} />)
    try {
      await act(async () => renderer.root.findByProps({ 'aria-label': 'Directory path' }).props.onChange({ target: { value: '/new' } }))
      await act(async () => renderer.root.findByProps({ 'aria-label': 'Directory path' }).props.onKeyDown({ key: 'Enter', preventDefault() {} }))
      await resolveAndFlush(controller)
      expect(renderer.root.findByProps({ 'data-testid': 'directory-choose' }).props.disabled).toBe(true)
      await resolveAndFlush(controller)
      expect(renderer.root.findByProps({ 'data-testid': 'directory-current-path' }).children.join('')).toBe('/new')
    } finally { await cleanup(renderer) }
  })

  test('recent project chooses a validated path without navigating a second dialog', async () => {
    useSettingsStore.setState({ recentPaths: ['/one', '/two'] })
    const selected: string[] = []
    const controller = createFetchController([createJsonResponse(makeListing({ path: '/two' }))])
    const renderer = await createBrowser(<ProjectPathInput value="" onChange={path => selected.push(path)} placeholder="Project" remote={false} onBrowse={() => {}} />)
    try {
      await act(async () => renderer.root.findByType('input').props.onFocus())
      const options = renderer.root.findAllByProps({ role: 'option' })
      expect(options).toHaveLength(2)
      await act(async () => options[1].props.onClick())
      expect(selected).toEqual([])
      await resolveAndFlush(controller)
      expect(selected).toEqual(['/two'])
      expect(renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
    } finally { await cleanup(renderer) }
  })

  test('editing while a recent project validates cancels its selection', async () => {
    useSettingsStore.setState({ recentPaths: ['/one'] })
    const selected: string[] = []
    const controller = createFetchController([createJsonResponse(makeListing({ path: '/one' }))])
    const renderer = await createBrowser(<ProjectPathInput value="" onChange={path => selected.push(path)} placeholder="Project" remote={false} onBrowse={() => {}} />)
    try {
      await act(async () => renderer.root.findByType('input').props.onFocus())
      await act(async () => renderer.root.findByProps({ role: 'option' }).props.onClick())
      await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: '/new' } }))
      await resolveAndFlush(controller)
      expect(selected).toEqual(['/new'])
    } finally { await cleanup(renderer) }
  })

  test('SSH host paths do not request local suggestions', async () => {
    const controller = createFetchController([])
    const renderer = await createBrowser(<ProjectPathInput value="/remote" onChange={() => {}} placeholder="Project" remote={true} onBrowse={() => {}} />)
    try {
      await act(async () => renderer.root.findByType('input').props.onFocus())
      expect(renderer.root.findAllByProps({ role: 'listbox' })).toHaveLength(0)
      expect(controller.calls).toEqual([])
    } finally { await cleanup(renderer) }
  })
})
