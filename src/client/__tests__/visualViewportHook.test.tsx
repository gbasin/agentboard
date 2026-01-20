import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import { useVisualViewport } from '../hooks/useVisualViewport'

const globalAny = globalThis as typeof globalThis & {
  window?: Window
  document?: Document
}

const originalWindow = globalAny.window
const originalDocument = globalAny.document

function HookHarness() {
  useVisualViewport()
  return null
}

afterEach(() => {
  globalAny.window = originalWindow
  globalAny.document = originalDocument
})

function createMockClassList() {
  const classes = new Set<string>()
  return {
    add: (cls: string) => classes.add(cls),
    remove: (cls: string) => classes.delete(cls),
    has: (cls: string) => classes.has(cls),
  }
}

describe('useVisualViewport', () => {
  test('registers viewport listeners and clears inset on cleanup', () => {
    const events = new Map<string, EventListener>()
    const removed: string[] = []
    const style = {
      values: new Map<string, string>(),
      setProperty: (_key: string, val: string) => {
        style.values.set(_key, val)
      },
      removeProperty: (_key: string) => {
        style.values.delete(_key)
      },
    }
    const classList = createMockClassList()

    const viewport = {
      height: 700,
      width: 800,
      addEventListener: (event: string, handler: EventListener) => {
        events.set(event, handler)
      },
      removeEventListener: (event: string) => {
        removed.push(event)
      },
    } as unknown as VisualViewport

    globalAny.window = {
      innerHeight: 900,
      screen: { height: 900 },
      visualViewport: viewport,
    } as unknown as Window & typeof globalThis

    globalAny.document = {
      documentElement: { style, classList },
    } as unknown as Document

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<HookHarness />)
    })

    expect(style.values.get('--keyboard-inset')).toBe('200px')
    expect(style.values.get('--viewport-offset-top')).toBe('0px')
    expect(style.values.get('--viewport-offset-left')).toBe('0px')
    expect(style.values.get('--visual-viewport-height')).toBe('700px')
    expect(style.values.get('--visual-viewport-width')).toBe('800px')
    expect(events.has('resize')).toBe(true)
    expect(events.has('scroll')).toBe(true)

    events.get('resize')?.({} as Event)
    expect(style.values.get('--keyboard-inset')).toBe('200px')

    act(() => {
      renderer.unmount()
    })

    expect(removed).toEqual(['resize', 'scroll'])
    expect(style.values.has('--keyboard-inset')).toBe(false)
    expect(style.values.has('--viewport-offset-top')).toBe(false)
    expect(style.values.has('--viewport-offset-left')).toBe(false)
    expect(style.values.has('--visual-viewport-height')).toBe(false)
    expect(style.values.has('--visual-viewport-width')).toBe(false)
  })
})
