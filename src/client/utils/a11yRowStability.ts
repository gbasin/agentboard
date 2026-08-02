/**
 * Keep xterm's accessibility-tree row nodes alive across repaints so iOS text
 * selection survives.
 *
 * On iOS the terminal canvas holds no selectable text, so we enable xterm's
 * `screenReaderMode` and let native long-press select against the DOM mirror it
 * builds. xterm's AccessibilityManager repaints that mirror by assigning
 * `element.textContent` for every row in the refresh range, with no comparison
 * against what the row already holds. Assigning textContent destroys the
 * existing Text node and creates a new one even when the string is identical,
 * and a Selection anchored to the old node collapses.
 *
 * RenderDebouncer makes it much worse: it coalesces pending refreshes into a
 * single min/max span, so one genuinely-changed row repaints every row between
 * it and any other dirty row. Measured against Claude Code in fullscreen, a
 * single keystroke in the prompt box rewrote the whole viewport, and 97% of
 * those rewrites wrote byte-identical text. Idle, it was 100% of them.
 *
 * We shadow `textContent`/`innerText` on each row element with a setter that
 * drops no-op writes and delegates real ones. Only the text write is guarded:
 * `aria-posinset` and `aria-setsize` are derived from `buffer.ydisp` and must
 * still be reassigned on every pass, because a row's position changes on scroll
 * even when its text does not.
 *
 * The real home for this is a dirty check inside xterm's AccessibilityManager;
 * this is the same guard applied from outside, since the row elements are
 * internal to xterm and the package ships only a minified build.
 */

const GUARDED = new WeakSet<HTMLElement>()

function describedTextSetter(prop: 'textContent' | 'innerText'): {
  get: () => string
  set: (value: string) => void
} | null {
  const proto = prop === 'textContent' ? Node.prototype : HTMLElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, prop)
  if (!desc?.get || !desc.set) return null
  return { get: desc.get as () => string, set: desc.set as (value: string) => void }
}

/** Shadow a row's text accessors so identical writes leave the Text node alone. */
function guardRow(row: HTMLElement): void {
  if (GUARDED.has(row)) return
  GUARDED.add(row)

  for (const prop of ['textContent', 'innerText'] as const) {
    const base = describedTextSetter(prop)
    if (!base) continue
    Object.defineProperty(row, prop, {
      configurable: true,
      enumerable: false,
      get(this: HTMLElement) {
        return base.get.call(this)
      },
      set(this: HTMLElement, value: string) {
        // Compare against textContent for both props: after xterm writes
        // innerText for a blank row the node's textContent is that same string,
        // so this is the value that decides whether the node must be replaced.
        const current = describedTextSetter('textContent')?.get.call(this)
        if (current === value) return
        base.set.call(this, value)
      },
    })
  }
}

/**
 * Guard every row in `tree` and any row xterm adds later (rows are recreated on
 * resize and shuffled at the scroll boundaries). Returns a disposer.
 */
export function keepA11yRowsStable(tree: HTMLElement): () => void {
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
