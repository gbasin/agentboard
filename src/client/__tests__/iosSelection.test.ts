import { describe, expect, test } from 'bun:test'
import {
  APP_MOUSE_ATTR,
  MEASURE_PROBE_ATTR,
  setAppOwnsMouse,
  watchSelectedRows,
} from '../utils/iosSelection'

// Minimal node stand-ins: identity is all the helpers compare.
function fakeNode(name: string, attrs: string[] = []) {
  return {
    name,
    hasAttribute: (attr: string) => attrs.includes(attr),
  } as unknown as Node & { name: string }
}

function fakeContainer(tree: Node | null, treeChildren: Node[]) {
  const attrs = new Set<string>()
  const container = {
    hasAttribute: (name: string) => attrs.has(name),
    setAttribute: (name: string) => { attrs.add(name) },
    removeAttribute: (name: string) => { attrs.delete(name) },
    querySelector: (selector: string) => (selector === '.xterm-accessibility-tree' ? tree : null),
  } as unknown as Element
  if (tree) {
    ;(tree as unknown as { contains: (n: Node) => boolean }).contains = (n: Node) => treeChildren.includes(n)
  }
  return { container, attrs }
}

function fakeSelection(opts: {
  anchor?: Node | null
  collapsed?: boolean
  intersects?: (n: Node) => boolean
}) {
  let removed = 0
  const selection = {
    rangeCount: opts.collapsed ? 0 : 1,
    isCollapsed: opts.collapsed ?? false,
    anchorNode: opts.anchor ?? null,
    focusNode: opts.anchor ?? null,
    getRangeAt: () => ({ intersectsNode: opts.intersects ?? (() => false) }) as unknown as Range,
    removeAllRanges: () => { removed += 1 },
  }
  return { selection, removed: () => removed }
}

describe('setAppOwnsMouse', () => {
  test('marks the container while the app owns the mouse and unmarks it after', () => {
    const { container, attrs } = fakeContainer(fakeNode('tree'), [])
    setAppOwnsMouse(container, true, null)
    expect(attrs.has(APP_MOUSE_ATTR)).toBe(true)
    setAppOwnsMouse(container, false, null)
    expect(attrs.has(APP_MOUSE_ATTR)).toBe(false)
  })

  test('drops a native selection already in the mirror when the app takes the mouse', () => {
    const row = fakeNode('row')
    const { container } = fakeContainer(fakeNode('tree'), [row])
    const sel = fakeSelection({ anchor: row })
    setAppOwnsMouse(container, true, sel.selection)
    expect(sel.removed()).toBe(1)
  })

  test('leaves selections outside the terminal alone', () => {
    const { container } = fakeContainer(fakeNode('tree'), [])
    const sel = fakeSelection({ anchor: fakeNode('elsewhere') })
    setAppOwnsMouse(container, true, sel.selection)
    expect(sel.removed()).toBe(0)
  })

  test('does nothing when ownership is unchanged (status polls repeat every 750ms)', () => {
    const row = fakeNode('row')
    const { container } = fakeContainer(fakeNode('tree'), [row])
    setAppOwnsMouse(container, true, null)
    const sel = fakeSelection({ anchor: row })
    setAppOwnsMouse(container, true, sel.selection)
    expect(sel.removed()).toBe(0)
  })

  test('tolerates a missing container', () => {
    expect(() => setAppOwnsMouse(null, true, null)).not.toThrow()
  })
})

describe('watchSelectedRows', () => {
  class FakeObserver {
    static last: FakeObserver | null = null
    observed: { target: Node; options: MutationObserverInit } | null = null
    disconnected = false
    constructor(public callback: MutationCallback) {
      FakeObserver.last = this
    }
    observe(target: Node, options: MutationObserverInit) {
      this.observed = { target, options }
    }
    disconnect() {
      this.disconnected = true
    }
    fire(records: Partial<MutationRecord>[]) {
      this.callback(records as MutationRecord[], this as unknown as MutationObserver)
    }
  }

  const record = (target: Node, added: Node[] = [], removed: Node[] = []) => ({
    target,
    addedNodes: added as unknown as NodeList,
    removedNodes: removed as unknown as NodeList,
  })

  function setup(selection: ReturnType<typeof fakeSelection>['selection'] | null) {
    const tree = fakeNode('tree')
    let stale = 0
    const stop = watchSelectedRows(tree, () => selection, () => { stale += 1 }, FakeObserver)
    const observer = FakeObserver.last!
    return { tree, observer, stop, stale: () => stale }
  }

  test('observes row text and row membership under the tree', () => {
    const { tree, observer } = setup(null)
    expect(observer.observed?.target).toBe(tree)
    expect(observer.observed?.options).toEqual({ childList: true, subtree: true, characterData: true })
  })

  test('clears when a row under the selection changes', () => {
    const selectedRow = fakeNode('selected')
    const { observer, stale } = setup(fakeSelection({ intersects: (n) => n === selectedRow }).selection)
    observer.fire([record(selectedRow)])
    expect(stale()).toBe(1)
  })

  test('keeps the selection when only other rows change (e.g. a spinner)', () => {
    const selectedRow = fakeNode('selected')
    const spinnerRow = fakeNode('spinner')
    const { observer, stale } = setup(fakeSelection({ intersects: (n) => n === selectedRow }).selection)
    observer.fire([record(spinnerRow)])
    expect(stale()).toBe(0)
  })

  test('clears when rows are added or removed at the tree level (scroll, resize)', () => {
    const { tree, observer, stale } = setup(fakeSelection({}).selection)
    observer.fire([record(tree, [fakeNode('new-row')])])
    expect(stale()).toBe(1)
  })

  test('ignores the glyph-width measurement probe', () => {
    const probe = fakeNode('probe', [MEASURE_PROBE_ATTR])
    const { tree, observer, stale } = setup(fakeSelection({}).selection)
    observer.fire([record(tree, [probe]), record(tree, [], [probe])])
    expect(stale()).toBe(0)
  })

  test('ignores mutations when nothing is selected', () => {
    const row = fakeNode('row')
    const { observer, stale } = setup(fakeSelection({ collapsed: true, intersects: () => true }).selection)
    observer.fire([record(row)])
    expect(stale()).toBe(0)
  })

  test('disconnects on stop', () => {
    const { observer, stop } = setup(null)
    stop()
    expect(observer.disconnected).toBe(true)
  })
})
