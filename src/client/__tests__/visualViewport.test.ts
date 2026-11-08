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
      values: new Map<string, string>(),
      setProperty: (_key: string, val: string) => {
        style.values.set(_key, val)
      },
      removeProperty: (_key: string) => {
        style.values.delete(_key)
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 900, screen: { height: 900 } } as Window
    const viewport = { height: 700, width: 800 } as VisualViewport

    const updated = updateKeyboardInset({ viewport, win, doc })
    expect(updated).toBe(true)
    expect(style.values.get('--keyboard-inset')).toBe('200px')
    expect(style.values.get('--viewport-offset-top')).toBe('0px')
    expect(style.values.get('--viewport-offset-left')).toBe('0px')
    expect(style.values.get('--visual-viewport-height')).toBe('700px')
    expect(style.values.get('--visual-viewport-width')).toBe('800px')
    expect(classList.has('keyboard-visible')).toBe(true)

    clearKeyboardInset(doc)
    expect(style.values.has('--keyboard-inset')).toBe(false)
    expect(style.values.has('--viewport-offset-top')).toBe(false)
    expect(style.values.has('--viewport-offset-left')).toBe(false)
    expect(style.values.has('--visual-viewport-height')).toBe(false)
    expect(style.values.has('--visual-viewport-width')).toBe(false)
    expect(classList.has('keyboard-visible')).toBe(false)
  })

  test('returns false when viewport is missing', () => {
    const doc = {
      documentElement: { style: { setProperty: () => {} } },
    } as unknown as Document
    const win = { innerHeight: 900, screen: { height: 900 } } as Window

    expect(updateKeyboardInset({ viewport: null, win, doc })).toBe(false)
  })

  test('clamps negative keyboard inset to zero', () => {
    const style = {
      values: new Map<string, string>(),
      setProperty: (_key: string, val: string) => {
        style.values.set(_key, val)
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 600, screen: { height: 600 } } as Window
    const viewport = { height: 800, width: 900 } as VisualViewport

    const updated = updateKeyboardInset({ viewport, win, doc })
    expect(updated).toBe(true)
    expect(style.values.get('--keyboard-inset')).toBe('0px')
    expect(style.values.get('--visual-viewport-height')).toBe('800px')
    expect(style.values.get('--visual-viewport-width')).toBe('900px')
    // Keyboard not visible when height is 0
    expect(classList.has('keyboard-visible')).toBe(false)
  })

  test('toggles keyboard-visible class based on threshold', () => {
    const style = {
      values: new Map<string, string>(),
      setProperty: (_key: string, val: string) => {
        style.values.set(_key, val)
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 900, screen: { height: 900 } } as Window

    // Below threshold (100px) - not visible
    updateKeyboardInset({ viewport: { height: 850, width: 800 } as VisualViewport, win, doc })
    expect(classList.has('keyboard-visible')).toBe(false)

    // Above threshold - visible
    updateKeyboardInset({ viewport: { height: 700, width: 800 } as VisualViewport, win, doc })
    expect(classList.has('keyboard-visible')).toBe(true)
  })

  test('tracks viewport position without subtracting panning from keyboard height', () => {
    const style = {
      values: new Map<string, string>(),
      setProperty: (_key: string, val: string) => {
        style.values.set(_key, val)
      },
    }
    const classList = createMockClassList()
    const doc = {
      documentElement: { style, classList },
    } as unknown as Document
    const win = { innerHeight: 900, screen: { height: 900 } } as Window
    const viewport = { height: 600, width: 700, offsetTop: 100, offsetLeft: 20 } as VisualViewport

    const updated = updateKeyboardInset({ viewport, win, doc })
    expect(updated).toBe(true)
    expect(style.values.get('--keyboard-inset')).toBe('300px')
    expect(style.values.get('--viewport-offset-top')).toBe('100px')
    expect(style.values.get('--visual-viewport-height')).toBe('600px')
    expect(style.values.get('--viewport-offset-left')).toBe('20px')
    expect(style.values.get('--visual-viewport-width')).toBe('700px')
  })

  test('keeps the keyboard visible through the iOS 27.2 scroll trace and clears it on dismissal', () => {
    const values = new Map<string, string>()
    const classList = createMockClassList()
    const doc = {
      documentElement: {
        clientHeight: 844,
        style: { setProperty: (key: string, value: string) => values.set(key, value) },
        classList,
      },
    } as unknown as Document
    const viewport = { width: 420, height: 429, scale: 1, offsetTop: 0 } as VisualViewport
    const win = { innerHeight: 844 } as Window

    // Recorded on an iPhone Air simulator: keyboard stays open throughout.
    for (const [innerHeight, offsetTop] of [[844, 0], [653, 191], [429, 415]]) {
      Object.assign(win, { innerHeight })
      Object.assign(viewport, { offsetTop })
      updateKeyboardInset({ viewport, win, doc })
      expect(values.get('--keyboard-inset')).toBe('415px')
      expect(classList.has('keyboard-visible')).toBe(true)
    }

    Object.assign(win, { innerHeight: 844 })
    Object.assign(viewport, { height: 844, offsetTop: 0 })
    updateKeyboardInset({ viewport, win, doc })
    expect(values.get('--keyboard-inset')).toBe('0px')
    expect(classList.has('keyboard-visible')).toBe(false)

    // Rotation/window resizing changes the current layout, without a stale baseline.
    Object.assign(doc.documentElement, { clientHeight: 420 })
    Object.assign(win, { innerHeight: 420 })
    Object.assign(viewport, { height: 420, width: 844 })
    updateKeyboardInset({ viewport, win, doc })
    expect(classList.has('keyboard-visible')).toBe(false)

    // Pinch zoom alone must not hide safe areas.
    Object.assign(viewport, { height: 210, scale: 2, offsetTop: 100 })
    updateKeyboardInset({ viewport, win, doc })
    expect(values.get('--keyboard-inset')).toBe('0px')
    expect(classList.has('keyboard-visible')).toBe(false)
    Object.assign(viewport, { height: 110 })
    updateKeyboardInset({ viewport, win, doc })
    expect(values.get('--keyboard-inset')).toBe('200px')
    expect(classList.has('keyboard-visible')).toBe(true)
  })
})
