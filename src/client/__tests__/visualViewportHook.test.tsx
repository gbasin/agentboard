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

describe('useVisualViewport', () => {
  test('registers viewport listeners and clears inset on cleanup', () => {
    const events = new Map<string, EventListener>()
    const removed: string[] = []
    const style = {
      value: '',
      setProperty: (_key: string, val: string) => {
        style.value = val
      },
      removeProperty: (_key: string) => {
        style.value = ''
      },
    }

    const viewport = {
      height: 700,
      addEventListener: (event: string, handler: EventListener) => {
        events.set(event, handler)
      },
      removeEventListener: (event: string) => {
        removed.push(event)
      },
    } as unknown as VisualViewport

    globalAny.window = {
      innerHeight: 900,
      visualViewport: viewport,
    } as unknown as Window & typeof globalThis

    globalAny.document = {
      documentElement: { style },
    } as unknown as Document

    let renderer!: TestRenderer.ReactTestRenderer

    act(() => {
      renderer = TestRenderer.create(<HookHarness />)
    })

    expect(style.value).toBe('200px')
    expect(events.has('resize')).toBe(true)
    expect(events.has('scroll')).toBe(true)

    events.get('resize')?.({} as Event)
    expect(style.value).toBe('200px')

    act(() => {
      renderer.unmount()
    })

    expect(removed).toEqual(['resize', 'scroll'])
    expect(style.value).toBe('')
  })
})
