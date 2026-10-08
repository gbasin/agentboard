import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { PersistenceHealth } from '@shared/persistence'
import type { ServerMessage } from '@shared/types'

const globalAny = globalThis as any

const originalFetch = globalThis.fetch
const originalLocalStorage = globalAny.localStorage

const { RecoveryNotice } = await import('../components/history/RecoveryNotice')

function makeHealth(overrides: Partial<PersistenceHealth> = {}): PersistenceHealth {
  return {
    lastSavedAt: null,
    error: null,
    matchingAvailable: true,
    interrupted: 0,
    interruptedIds: [],
    settings: { autoResume: false, capturePreviews: false },
    ...overrides,
  }
}

let currentHealth: PersistenceHealth
let store: Map<string, string>
let listeners: Set<(message: ServerMessage) => void>
const renderers: TestRenderer.ReactTestRenderer[] = []

const subscribe = (listener: (message: ServerMessage) => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

async function renderNotice(onOpen = () => {}) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      <RecoveryNotice onOpen={onOpen} subscribe={subscribe} />
    )
  })
  renderers.push(renderer)
  return renderer
}

function notice(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAllByProps({ 'data-testid': 'recovery-notice' })
}

async function emit(message: ServerMessage) {
  await act(async () => {
    for (const listener of listeners) listener(message)
  })
}

beforeEach(() => {
  store = new Map()
  globalAny.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage
  listeners = new Set()
  currentHealth = makeHealth()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input) === '/api/library/health') {
      return new Response(JSON.stringify(currentHealth), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
})

afterEach(() => {
  renderers.splice(0).forEach((r) => {
    act(() => r.unmount())
  })
  globalThis.fetch = originalFetch
  if (originalLocalStorage === undefined) delete globalAny.localStorage
  else globalAny.localStorage = originalLocalStorage
})

describe('RecoveryNotice', () => {
  test('renders nothing when there are no interrupted sessions', async () => {
    const renderer = await renderNotice()
    expect(notice(renderer)).toHaveLength(0)
  })

  test('singularizes the message for one interrupted session', async () => {
    currentHealth = makeHealth({ interrupted: 1, interruptedIds: ['s1'] })
    const renderer = await renderNotice()
    const text = notice(renderer)[0]
      .findAllByType('button')[0]
      .props.children as string
    expect(text).toContain('1 interrupted session saved.')
  })

  test('pluralizes the message for multiple interrupted sessions', async () => {
    currentHealth = makeHealth({ interrupted: 2, interruptedIds: ['s1', 's2'] })
    const renderer = await renderNotice()
    const text = notice(renderer)[0]
      .findAllByType('button')[0]
      .props.children as string
    expect(text).toContain('2 interrupted sessions saved.')
  })

  test('clears immediately on library-changed instead of waiting for the poll', async () => {
    currentHealth = makeHealth({ interrupted: 1, interruptedIds: ['s1'] })
    const renderer = await renderNotice()
    expect(notice(renderer)).toHaveLength(1)

    currentHealth = makeHealth()
    await emit({ type: 'library-changed' })
    expect(notice(renderer)).toHaveLength(0)
  })

  test('dismiss hides the notice and persists across remounts', async () => {
    currentHealth = makeHealth({ interrupted: 1, interruptedIds: ['s1'] })
    const renderer = await renderNotice()
    const dismiss = renderer.root.findByProps({ 'aria-label': 'Dismiss' })
    act(() => {
      dismiss.props.onClick()
    })
    expect(notice(renderer)).toHaveLength(0)

    const remounted = await renderNotice()
    expect(notice(remounted)).toHaveLength(0)
  })

  test('reappears when a new session is interrupted after a dismissal', async () => {
    currentHealth = makeHealth({ interrupted: 1, interruptedIds: ['s1'] })
    const renderer = await renderNotice()
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Dismiss' }).props.onClick()
    })
    expect(notice(renderer)).toHaveLength(0)

    currentHealth = makeHealth({ interrupted: 1, interruptedIds: ['s2'] })
    await emit({ type: 'library-changed' })
    expect(notice(renderer)).toHaveLength(1)
  })

  test('shows an error-only notice and dismisses until the error changes', async () => {
    currentHealth = makeHealth({ error: 'catalog write failed' })
    const renderer = await renderNotice()
    const text = notice(renderer)[0]
      .findAllByType('button')[0]
      .props.children as string
    expect(text).toContain('Session recovery needs attention')

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Dismiss' }).props.onClick()
    })
    expect(notice(renderer)).toHaveLength(0)

    currentHealth = makeHealth({ error: 'a different failure' })
    await emit({ type: 'library-changed' })
    expect(notice(renderer)).toHaveLength(1)
  })
})
