/**
 * Decide who owns iOS text selection in the terminal, and keep native
 * highlights honest.
 *
 * On iOS a long-press selects text in xterm's accessibility mirror (see
 * a11yRowStability.ts). Two situations break that:
 *
 * - The pane's app owns the mouse (fullscreen Claude Code, Codex). Terminal.tsx
 *   forwards a long-press drag to the app as SGR mouse events, so the app draws
 *   its own selection and copies it via OSC 52, which surfaces as the clipboard
 *   offer popup. iOS also starts a native selection on the mirror for the same
 *   gesture, so the user sees two highlights with different ranges. While the
 *   app owns the mouse, `setAppOwnsMouse` marks the terminal container and CSS
 *   (index.css, `[data-app-mouse]`) turns native selection off beneath it.
 *   Clearing the mark restores native selection for shells and the classic
 *   Claude renderer.
 *
 * - Native selection stays on, but a Selection is anchored to row nodes, not to
 *   the text they held. When output rewrites those rows the highlight stays
 *   where it was, over unrelated text. `watchSelectedRows` clears the selection
 *   as soon as a row it covers changes.
 */

export const APP_MOUSE_ATTR = 'data-app-mouse'
const A11Y_TREE_SELECTOR = '.xterm-accessibility-tree'

type SelectionLike = Pick<
  Selection,
  'rangeCount' | 'isCollapsed' | 'anchorNode' | 'focusNode' | 'getRangeAt' | 'removeAllRanges'
>

function selectionInTree(tree: Node, selection: SelectionLike): boolean {
  const { anchorNode, focusNode } = selection
  return (!!anchorNode && tree.contains(anchorNode)) || (!!focusNode && tree.contains(focusNode))
}

/**
 * Mark (or unmark) the terminal container as app-owned for selection. Turning
 * ownership on also drops a native selection already sitting in the mirror,
 * since it can no longer be adjusted and would linger beside the app's own.
 */
export function setAppOwnsMouse(
  container: Element | null,
  appOwnsMouse: boolean,
  selection: SelectionLike | null,
): void {
  if (!container) return
  if (container.hasAttribute(APP_MOUSE_ATTR) === appOwnsMouse) return

  if (!appOwnsMouse) {
    container.removeAttribute(APP_MOUSE_ATTR)
    return
  }
  container.setAttribute(APP_MOUSE_ATTR, '')

  const tree = container.querySelector(A11Y_TREE_SELECTOR)
  if (tree && selection && !selection.isCollapsed && selectionInTree(tree, selection)) {
    selection.removeAllRanges()
  }
}

/**
 * Terminal.tsx briefly appends a span to the tree to measure glyph width. Mark
 * it with this attribute so the measurement does not read as a row change.
 */
export const MEASURE_PROBE_ATTR = 'data-a11y-measure-probe'

function onlyMeasureProbes(record: MutationRecord): boolean {
  const nodes = [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
  return nodes.length > 0 && nodes.every((node) => (node as Element).hasAttribute?.(MEASURE_PROBE_ATTR) === true)
}

type ObserverCtor =new (callback: MutationCallback) => Pick<MutationObserver, 'observe' | 'disconnect'>

/**
 * Call `onStale` when a row under the current selection changes.
 *
 * Unchanged rows never mutate (a11yRowStability drops no-op writes), so any
 * mutation here is real output. Rows added or removed at the tree level mean a
 * scroll or resize shifted every row, which also invalidates the highlight.
 */
export function watchSelectedRows(
  tree: Node,
  getSelection: () => SelectionLike | null,
  onStale: () => void,
  Observer: ObserverCtor = MutationObserver,
): () => void {
  const observer = new Observer((records) => {
    const selection = getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    for (const record of records) {
      if (record.target === tree) {
        if (onlyMeasureProbes(record)) continue
        onStale()
        return
      }
      if (range.intersectsNode(record.target)) {
        onStale()
        return
      }
    }
  })
  observer.observe(tree, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}
