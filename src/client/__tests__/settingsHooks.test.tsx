import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { getFocusable, nextTrapTarget } from '../components/settings/focusTrap'
import {
  DEFAULT_SETTINGS_PAGE,
  LAST_PAGE_STORAGE_KEY,
  loadLastPage,
  saveLastPage,
} from '../components/settings/lastPage'
import { useCommitField, type CommitField, type CommitFn } from '../components/settings/useCommitField'
import { useFocusTrap, useSuspendTerminalInput } from '../components/settings/useDialogFocus'
import { useServerSetting, type ServerSetting } from '../components/settings/useServerSetting'
import { parseClampedInt } from '../components/settings/controls/CommitInput'

const globalAny = globalThis as unknown as {
  localStorage?: Storage
  document?: unknown
}
const originalLocalStorage = globalAny.localStorage
const originalDocument = globalAny.document
const originalFetch = globalThis.fetch

afterEach(() => {
  globalAny.localStorage = originalLocalStorage
  globalAny.document = originalDocument
  globalThis.fetch = originalFetch
})

const keyEvent = (key: string) => {
  const event = { key, prevented: false, preventDefault: () => { event.prevented = true } }
  return event
}

describe('useCommitField', () => {
  let field!: CommitField
  let commits: string[] = []

  function Probe({ stored, commit }: { stored: string; commit: CommitFn }) {
    field = useCommitField(stored, commit)
    return null
  }

  const accept: CommitFn = (draft) => {
    commits.push(draft)
    return null
  }
  const rejectEmpty: CommitFn = (draft) => {
    if (!draft.trim()) return 'Required'
    commits.push(draft)
    return null
  }

  beforeEach(() => {
    commits = []
  })

  test('shows the stored value until edited, then the draft', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={accept} />) })
    expect(field.value).toBe('a')
    expect(field.dirty).toBe(false)
    act(() => field.onChange({ target: { value: 'b' } } as never))
    expect(field.value).toBe('b')
    expect(field.dirty).toBe(true)
    act(() => renderer.update(<Probe stored="remote" commit={accept} />))
    expect(field.value).toBe('b')
    act(() => renderer.unmount())
  })

  test('commits on blur and Enter, skipping unchanged drafts', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={accept} />) })
    act(() => field.onBlur())
    expect(commits).toEqual([])
    act(() => field.onChange({ target: { value: 'a' } } as never))
    act(() => field.onBlur())
    expect(commits).toEqual([])
    expect(field.dirty).toBe(false)
    act(() => field.onChange({ target: { value: 'b' } } as never))
    act(() => field.onBlur())
    expect(commits).toEqual(['b'])
    expect(field.dirty).toBe(false)
    act(() => field.onChange({ target: { value: 'c' } } as never))
    const enter = keyEvent('Enter')
    act(() => field.onKeyDown(enter as never))
    expect(enter.prevented).toBe(true)
    expect(commits).toEqual(['b', 'c'])
    act(() => renderer.unmount())
  })

  test('keeps an invalid draft local with an error', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={rejectEmpty} />) })
    act(() => field.onChange({ target: { value: ' ' } } as never))
    act(() => field.onBlur())
    expect(field.error).toBe('Required')
    expect(field.value).toBe(' ')
    expect(commits).toEqual([])
    act(() => field.onChange({ target: { value: 'x' } } as never))
    expect(field.error).toBeNull()
    act(() => renderer.unmount())
  })

  test('Escape reverts a dirty draft and is ignored when clean', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={rejectEmpty} />) })
    const clean = keyEvent('Escape')
    act(() => field.onKeyDown(clean as never))
    expect(clean.prevented).toBe(false)
    act(() => field.onChange({ target: { value: '' } } as never))
    act(() => field.onBlur())
    const dirty = keyEvent('Escape')
    act(() => field.onKeyDown(dirty as never))
    expect(dirty.prevented).toBe(true)
    expect(field.value).toBe('a')
    expect(field.error).toBeNull()
    act(() => field.onKeyDown(keyEvent('a') as never))
    act(() => renderer.unmount())
  })

  test('commits a dirty draft on unmount, never a clean or unchanged one', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={accept} />) })
    act(() => renderer.unmount())
    expect(commits).toEqual([])

    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={accept} />) })
    act(() => field.onChange({ target: { value: 'a' } } as never))
    act(() => renderer.unmount())
    expect(commits).toEqual([])

    act(() => { renderer = TestRenderer.create(<Probe stored="a" commit={accept} />) })
    act(() => field.onChange({ target: { value: 'typed' } } as never))
    act(() => renderer.unmount())
    expect(commits).toEqual(['typed'])
  })
})

describe('parseClampedInt', () => {
  test('parses, clamps and rejects', () => {
    expect(parseClampedInt(' 12 ', 1, 168)).toBe(12)
    expect(parseClampedInt('0', 1, 168)).toBe(1)
    expect(parseClampedInt('999', 1, 168)).toBe(168)
    expect(parseClampedInt('-5', 1, 168)).toBe(1)
    expect(parseClampedInt('1.5', 1, 168)).toBeNull()
    expect(parseClampedInt('', 1, 168)).toBeNull()
    expect(parseClampedInt('abc', 1, 168)).toBeNull()
  })
})

describe('useServerSetting', () => {
  let setting!: ServerSetting<boolean>
  function Probe() {
    setting = useServerSetting<boolean>('tmux-mouse-mode', 'enabled', true)
    return null
  }
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

  test('loads, then applies optimistically and keeps on OK', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET')
      return new Response(JSON.stringify({ enabled: false }), { status: 200 })
    }) as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    expect(setting.loading).toBe(true)
    expect(setting.loaded).toBe(false)
    await flush()
    expect(setting.loading).toBe(false)
    expect(setting.loaded).toBe(true)
    expect(setting.value).toBe(false)
    act(() => setting.set(true))
    expect(setting.value).toBe(true)
    expect(setting.loading).toBe(true)
    expect(setting.loaded).toBe(true)
    await flush()
    expect(setting.value).toBe(true)
    expect(setting.loading).toBe(false)
    expect(calls).toEqual(['GET', 'PUT'])
    act(() => renderer.unmount())
  })

  test('reverts on a non-OK response or a network error', async () => {
    let putStatus = 500
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        if (putStatus === 0) throw new Error('offline')
        return new Response('{}', { status: putStatus })
      }
      return new Response(JSON.stringify({ enabled: true }), { status: 200 })
    }) as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    await flush()
    act(() => setting.set(false))
    await flush()
    expect(setting.value).toBe(true)
    putStatus = 0
    act(() => setting.set(false))
    await flush()
    expect(setting.value).toBe(true)
    expect(setting.loading).toBe(false)
    act(() => renderer.unmount())
  })

  test('a failed load keeps the fallback and enables the control', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    await flush()
    expect(setting.value).toBe(true)
    expect(setting.loading).toBe(false)
    expect(setting.loaded).toBe(true)
    act(() => renderer.unmount())
  })

  test('a load that lands after a write is ignored', async () => {
    let resolveGet!: (response: Response) => void
    globalThis.fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return Promise.resolve(new Response('{}', { status: 200 }))
      return new Promise<Response>((resolve) => { resolveGet = resolve })
    }) as typeof fetch
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    act(() => setting.set(false))
    await flush()
    resolveGet(new Response(JSON.stringify({ enabled: true }), { status: 200 }))
    await flush()
    expect(setting.value).toBe(false)
    act(() => renderer.unmount())
  })
})

describe('focus trap helpers', () => {
  test('nextTrapTarget wraps at both ends and pulls stray focus in', () => {
    const items = ['a', 'b', 'c']
    expect(nextTrapTarget(items, 'c', false)).toBe('a')
    expect(nextTrapTarget(items, 'a', true)).toBe('c')
    expect(nextTrapTarget(items, 'b', false)).toBeNull()
    expect(nextTrapTarget(items, 'b', true)).toBeNull()
    expect(nextTrapTarget(items, 'x', false)).toBe('a')
    expect(nextTrapTarget(items, null, true)).toBe('c')
    expect(nextTrapTarget([], 'a', false)).toBeNull()
  })

  test('getFocusable drops aria-hidden and tabindex -1 elements', () => {
    const el = (tabIndex: number, hidden = false) => ({
      tabIndex,
      getAttribute: (name: string) => (name === 'aria-hidden' && hidden ? 'true' : null),
    })
    const keep = el(0)
    let selector = ''
    const root = {
      querySelectorAll: (query: string) => {
        selector = query
        return [keep, el(-1), el(0, true)]
      },
    }
    expect(getFocusable(root as unknown as ParentNode)).toEqual([keep as unknown as HTMLElement])
    expect(selector).toContain('button:not([disabled])')
  })
})

describe('lastPage', () => {
  test('round-trips a valid page and ignores junk', () => {
    const store = new Map<string, string>()
    globalAny.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    } as Storage
    expect(loadLastPage()).toBe(DEFAULT_SETTINGS_PAGE)
    saveLastPage('terminal')
    expect(store.get(LAST_PAGE_STORAGE_KEY)).toBe('terminal')
    expect(loadLastPage()).toBe('terminal')
    store.set(LAST_PAGE_STORAGE_KEY, 'bogus')
    expect(loadLastPage()).toBe(DEFAULT_SETTINGS_PAGE)
  })
})

interface FakeElement {
  name: string
  disabled: boolean
  focused: number
  blurred: number
  isConnected: boolean
  focus: () => void
  blur: () => void
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  contains?: (node: unknown) => boolean
}

function fakeElement(name: string): FakeElement {
  const el: FakeElement = {
    name,
    disabled: false,
    focused: 0,
    blurred: 0,
    isConnected: true,
    focus: () => { el.focused += 1; doc.activeElement = el },
    blur: () => { el.blurred += 1 },
    setAttribute: (attr) => { if (attr === 'disabled') el.disabled = true },
    removeAttribute: (attr) => { if (attr === 'disabled') el.disabled = false },
  }
  return el
}

const listeners = new Map<string, (event: unknown) => void>()
const doc = {
  body: { name: 'body' },
  activeElement: null as unknown,
  textarea: null as FakeElement | null,
  replacement: null as FakeElement | null,
  lastSelector: '',
  querySelector: (selector: string) => {
    doc.lastSelector = selector
    return selector.startsWith('button') ? doc.replacement : doc.textarea
  },
  addEventListener: (type: string, fn: (event: unknown) => void) => { listeners.set(type, fn) },
  removeEventListener: (type: string) => { listeners.delete(type) },
}

describe('useSuspendTerminalInput', () => {
  function Probe() {
    useSuspendTerminalInput()
    return null
  }

  beforeEach(() => {
    globalAny.document = doc
    doc.textarea = fakeElement('textarea')
    doc.activeElement = null
  })

  test('disables the textarea and refocuses the terminal on close, not the gear', async () => {
    const gear = fakeElement('gear')
    doc.activeElement = gear
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    expect(doc.textarea?.disabled).toBe(true)
    expect(doc.textarea?.blurred).toBe(1)
    act(() => renderer.unmount())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(doc.textarea?.disabled).toBe(false)
    expect(doc.textarea?.focused).toBe(1)
    expect(gear.focused).toBe(0)
  })

  test('without a terminal, focus returns to the opener', async () => {
    const gear = fakeElement('gear')
    doc.activeElement = gear
    doc.textarea = null
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    act(() => renderer.unmount())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(gear.focused).toBe(1)
  })

  test('without a terminal, a re-rendered opener is found by its label', async () => {
    const gear = Object.assign(fakeElement('gear'), { getAttribute: () => 'Set "x"' })
    doc.activeElement = gear
    doc.textarea = null
    doc.replacement = fakeElement('new gear')
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    gear.isConnected = false
    act(() => renderer.unmount())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(doc.lastSelector).toBe('button[aria-label="Set \\"x\\""]')
    expect(doc.replacement.focused).toBe(1)
    expect(gear.focused).toBe(0)
    doc.replacement = null
  })

  test('without a terminal, an unlabelled disconnected opener leaves focus alone', async () => {
    const gear = fakeElement('gear')
    doc.activeElement = gear
    doc.textarea = null
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    gear.isConnected = false
    act(() => renderer.unmount())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(gear.focused).toBe(0)
  })

  test('refocuses the terminal when it was the opener', async () => {
    doc.activeElement = doc.textarea
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    act(() => renderer.unmount())
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(doc.textarea?.disabled).toBe(false)
    expect(doc.textarea?.focused).toBe(1)
  })

  test('reopening within the delay keeps the terminal disabled', async () => {
    doc.activeElement = doc.body
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    act(() => renderer.unmount())
    act(() => { renderer = TestRenderer.create(<Probe />) })
    await new Promise((resolve) => setTimeout(resolve, 320))
    expect(doc.textarea?.disabled).toBe(true)
    act(() => renderer.unmount())
    doc.textarea = null
    await new Promise((resolve) => setTimeout(resolve, 320))
  })
})

describe('useFocusTrap', () => {
  let closes = 0
  const panel = {
    focused: 0,
    focus: () => { panel.focused += 1 },
    contains: (node: unknown) => node === inside,
    querySelectorAll: () => [first, last],
  }
  const inside = { name: 'inside' }
  const first = { tabIndex: 0, getAttribute: () => null, focus: () => { doc.activeElement = first } }
  const last = { tabIndex: 0, getAttribute: () => null, focus: () => { doc.activeElement = last } }

  function Probe() {
    const ref = useRef(panel as unknown as HTMLElement)
    useFocusTrap(ref, () => { closes += 1 })
    return null
  }

  beforeEach(() => {
    globalAny.document = doc
    closes = 0
    panel.focused = 0
  })

  const press = (key: string, extra: Record<string, unknown> = {}) => {
    const event = {
      key,
      defaultPrevented: false,
      prevented: false,
      preventDefault: () => { event.prevented = true },
      stopPropagation: () => {},
      ...extra,
    }
    listeners.get('keydown')?.(event)
    return event
  }

  test('Escape closes unless a control consumed it', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    press('Escape', { defaultPrevented: true })
    expect(closes).toBe(0)
    press('Escape')
    expect(closes).toBe(1)
    act(() => renderer.unmount())
    expect(listeners.has('keydown')).toBe(false)
  })

  test('Tab wraps inside the panel', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    doc.activeElement = last
    expect(press('Tab').prevented).toBe(true)
    expect(doc.activeElement).toBe(first)
    expect(press('Tab', { shiftKey: true }).prevented).toBe(true)
    expect(doc.activeElement).toBe(last)
    doc.activeElement = first
    expect(press('Tab').prevented).toBe(false)
    expect(press('a').prevented).toBe(false)
    act(() => renderer.unmount())
  })

  test('focus escaping the panel is pulled back', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => { renderer = TestRenderer.create(<Probe />) })
    listeners.get('focusin')?.({ target: inside })
    expect(panel.focused).toBe(0)
    listeners.get('focusin')?.({ target: { name: 'outside' } })
    expect(panel.focused).toBe(1)
    act(() => renderer.unmount())
  })
})
