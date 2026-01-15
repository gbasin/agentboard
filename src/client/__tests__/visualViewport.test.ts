import { describe, expect, test } from 'bun:test'
import { clearKeyboardInset, updateKeyboardInset } from '../hooks/useVisualViewport'

function createMockClassList() {
  const classes = new Set<string>()
  return {
    add: (cls: string) => classes.add(cls),
    remove: (cls: string) => classes.delete(cls),
    has: (cls: string) => classes.has(cls),
    _classes: classes,
  }
}

describe('visual viewport helpers', () => {
  test('updates keyboard inset and clears it', () => {
    const style = {
      value: '',
      setProperty: (_key: string, val: string) => {
        style.value = val
      },
      removeProperty: (_key: string) => {
        style.value = ''
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 900 } as Window
    const viewport = { height: 700 } as VisualViewport

    const updated = updateKeyboardInset({ viewport, win, doc })
    expect(updated).toBe(true)
    expect(style.value).toBe('200px')
    expect(classList.has('keyboard-visible')).toBe(true)

    clearKeyboardInset(doc)
    expect(style.value).toBe('')
    expect(classList.has('keyboard-visible')).toBe(false)
  })

  test('returns false when viewport is missing', () => {
    const doc = {
      documentElement: { style: { setProperty: () => {} } },
    } as unknown as Document
    const win = { innerHeight: 900 } as Window

    expect(updateKeyboardInset({ viewport: null, win, doc })).toBe(false)
  })

  test('clamps negative keyboard inset to zero', () => {
    const style = {
      value: '',
      setProperty: (_key: string, val: string) => {
        style.value = val
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 600 } as Window
    const viewport = { height: 800 } as VisualViewport

    const updated = updateKeyboardInset({ viewport, win, doc })
    expect(updated).toBe(true)
    expect(style.value).toBe('0px')
    // Keyboard not visible when height is 0
    expect(classList.has('keyboard-visible')).toBe(false)
  })

  test('toggles keyboard-visible class based on threshold', () => {
    const style = {
      value: '',
      setProperty: (_key: string, val: string) => {
        style.value = val
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 900 } as Window

    // Below threshold (100px) - not visible
    updateKeyboardInset({ viewport: { height: 850 } as VisualViewport, win, doc })
    expect(classList.has('keyboard-visible')).toBe(false)

    // Above threshold - visible
    updateKeyboardInset({ viewport: { height: 700 } as VisualViewport, win, doc })
    expect(classList.has('keyboard-visible')).toBe(true)
  })
})
