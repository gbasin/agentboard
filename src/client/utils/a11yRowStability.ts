/**
 * Keep xterm's accessibility-tree row nodes alive across repaints so iOS text
 * selection survives.
 *
 * On iOS the terminal canvas holds no selectable text, so we enable xterm's
 * `screenReaderMode` and let native long-press select against the DOM mirror it
 * builds. A Selection is anchored to a specific Text node, so it dies the
 * moment that node is replaced.
 *
 * xterm's AccessibilityManager repaints every row in the refresh range without
 * comparing against what the row already holds, and one of its two write paths
 * replaces the node unconditionally:
 *
 *   element.innerText = ' '    blank rows — always replaces the child node,
 *                                   even when the value is unchanged
 *   element.textContent = lineData  populated rows — browsers collapse this onto
 *                                   the existing node when the row already has
 *                                   exactly one Text child, but it still
 *                                   replaces when the row is empty
 *
 * RenderDebouncer widens the blast radius: it coalesces pending refreshes into
 * a single min/max span, so one genuinely-changed row drags every row between
 * it and any other dirty row into the repaint. Measured against Claude Code in
 * fullscreen, a single keystroke in the prompt box rewrote the whole viewport
 * and 97% of those rewrites wrote byte-identical text; idle, 100% of them did.
 * A held Text node came back detached and a live selection collapsed within six
 * seconds of an idle terminal.
 *
 * We shadow `textContent`/`innerText` on each row with a setter that drops
 * no-op writes and delegates real ones, which takes the measured churn to zero.
 * Only the text write is guarded: `aria-posinset` and `aria-setsize` derive
 * from `buffer.ydisp` and must still be reassigned on every pass, because a
 * row's position changes on scroll even when its text does not.
 *
 * The real home for this is a dirty check inside xterm's AccessibilityManager;
 * this is the same guard applied from outside, since the row elements are
 * internal to xterm and the package ships only a minified build.
 */

const GUARDED = new WeakSet<HTMLElement>()

interface TextAccessor {
  get: (this: HTMLElement) => string
  set: (this: HTMLElement, value: string) => void
  enumerable: boolean
  configurable: boolean
}

function nativeAccessor(proto: object, prop: string): TextAccessor | null {
  const desc = Object.getOwnPropertyDescriptor(proto, prop)
  if (!desc?.get || !desc.set) return null
  return {
    get: desc.get as TextAccessor['get'],
    set: desc.set as TextAccessor['set'],
    // Mirror the native flags so the shadow stays indistinguishable from the
    // prototype accessor it hides (both are enumerable and configurable).
    enumerable: desc.enumerable ?? true,
    configurable: desc.configurable ?? true,
  }
}

// Resolved once on first use, not at module scope: looking these up per write
// would cost a descriptor allocation on every repaint (the hot path this module
// exists to make cheap), but touching Node/HTMLElement at import time would
// throw in the DOM-less environment the unit tests run in.
let accessorsResolved = false
let nativeTextContent: TextAccessor | null = null
let nativeInnerText: TextAccessor | null = null

function resolveAccessors(): void {
  if (accessorsResolved) return
  accessorsResolved = true
  if (typeof Node === 'undefined' || typeof HTMLElement === 'undefined') return
  nativeTextContent = nativeAccessor(Node.prototype, 'textContent')
  nativeInnerText = nativeAccessor(HTMLElement.prototype, 'innerText')
}

/** Shadow a row's text accessors so identical writes leave the Text node alone. */
function guardRow(row: HTMLElement): void {
  if (GUARDED.has(row)) return
  GUARDED.add(row)

  const readCurrent = nativeTextContent?.get
  if (!readCurrent) return

  for (const [prop, native] of [
    ['textContent', nativeTextContent],
    ['innerText', nativeInnerText],
  ] as const) {
    if (!native) continue
    Object.defineProperty(row, prop, {
      configurable: native.configurable,
      enumerable: native.enumerable,
      get(this: HTMLElement) {
        return native.get.call(this)
      },
      set(this: HTMLElement, value: string) {
        // Compare against textContent for both props: after xterm writes
        // innerText for a blank row the node's textContent is that same string,
        // so this is the value that decides whether the node must be replaced.
        if (readCurrent.call(this) === value) return
        native.set.call(this, value)
      },
    })
  }
}

/**
 * Guard every row in `tree` and any row xterm adds later (rows are recreated on
 * resize and shuffled at the scroll boundaries).
 *
 * The returned disposer stops adopting new rows but deliberately leaves the
 * accessors on rows already guarded. The effect that owns this re-runs on font
 * and session changes against the same live tree, and tearing the shadows down
 * only to reinstall them would leave a window where a repaint could land
 * unguarded. Rows are discarded with the terminal, so nothing outlives it.
 */
export function keepA11yRowsStable(tree: HTMLElement): () => void {
  resolveAccessors()

  const guardAll = () => {
    for (const child of Array.from(tree.children)) {
      if (child instanceof HTMLElement) guardRow(child)
    }
  }

  guardAll()

  // Only childList on the tree itself: we react to rows being added, never to
  // their contents, so arming a row cannot retrigger this observer.
  const observer = new MutationObserver(guardAll)
  observer.observe(tree, { childList: true })

  return () => observer.disconnect()
}
