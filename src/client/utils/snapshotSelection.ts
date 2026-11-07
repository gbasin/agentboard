/**
 * snapshotSelection - maps a DOM selection in the snapshot layer back to the
 * captured lines, so the layer writes clipboard text itself instead of
 * trusting WebKit's serialisation (which dropped leading spaces unpredictably).
 *
 * The layer renders one element per captured line, marked with
 * `data-snapshot-line="<index>"` and holding text and optional link elements (or a <br>
 * for a blank line), so a range boundary resolves to a line and a column.
 */

import { selectedSnapshotText, type SnapshotPoint } from './snapshotText'
import type { RowJoin } from './snapshotRejoin'

export const SNAPSHOT_LINE_ATTR = 'data-snapshot-line'

const TEXT_NODE = 3

interface NodeLike {
  ownerDocument?: Document
  nodeType: number
  parentElement: ElementLike | null
}
interface ElementLike extends NodeLike {
  closest(selector: string): ElementLike | null
  getAttribute(name: string): string | null
}
interface RootLike {
  contains(node: unknown): boolean
}
interface RangeLike {
  startContainer: unknown
  startOffset: number
  endContainer: unknown
  endOffset: number
}

/** Line and column of one range boundary, or null when it is outside `root`. */
export function resolveSnapshotPoint(root: RootLike, node: unknown, offset: number, lineCount: number): SnapshotPoint | null {
  if (lineCount === 0) return null
  if (node === root) {
    return offset >= lineCount ? { line: lineCount - 1, col: Infinity } : { line: offset, col: 0 }
  }
  const n = node as NodeLike | null
  if (!n || typeof n.nodeType !== 'number') return null
  const element = n.nodeType === TEXT_NODE ? n.parentElement : (n as ElementLike)
  const lineElement = element?.closest?.(`[${SNAPSHOT_LINE_ATTR}]`) ?? null
  if (!lineElement || !root.contains(lineElement)) return null
  const line = Number(lineElement.getAttribute(SNAPSHOT_LINE_ATTR))
  if (!Number.isInteger(line) || line < 0 || line >= lineCount) return null
  // Count all preceding text, including sibling text nodes and nested links.
  if (n.ownerDocument) {
    const range = n.ownerDocument.createRange()
    range.selectNodeContents(lineElement as unknown as Node)
    range.setEnd(n as unknown as Node, offset)
    return { line, col: range.toString().length }
  }
  if (n.nodeType === TEXT_NODE) return { line, col: offset }
  return { line, col: offset === 0 ? 0 : Infinity }
}

/**
 * Normalised clipboard text for `range`, or null when it is not in the layer.
 * `joins` marks the rows the app wrapped itself (empty: copy rows as shown).
 */
export function snapshotCopyText(root: RootLike, range: RangeLike, lines: string[], joins: readonly RowJoin[] = []): string | null {
  const start = resolveSnapshotPoint(root, range.startContainer, range.startOffset, lines.length)
  const end = resolveSnapshotPoint(root, range.endContainer, range.endOffset, lines.length)
  if (!start || !end) return null
  return selectedSnapshotText(lines, start, end, joins)
}

interface CopyEventLike {
  clipboardData: Pick<DataTransfer, 'setData'> | null
  preventDefault(): void
}
interface SelectionSource {
  rangeCount: number
  isCollapsed: boolean
  getRangeAt(index: number): RangeLike
}

/**
 * Copy handler body: when the selection lies in the layer, write the
 * normalised text and cancel the browser's own copy. Returns whether it did.
 */
export function handleSnapshotCopy(
  event: CopyEventLike,
  selection: SelectionSource | null,
  root: RootLike,
  lines: string[],
  joins: readonly RowJoin[] = [],
): boolean {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !event.clipboardData) return false
  const text = snapshotCopyText(root, selection.getRangeAt(0), lines, joins)
  if (text === null) return false
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
  return true
}

/**
 * Copy handler for the layer: write the selection's text, then run
 * `afterCopy` on a later task. Running it inside the handler would close the
 * layer (unmounting the selection) while the browser still finishes the
 * copy. Returns whether the copy was handled.
 */
export function copyThenAfter(
  event: CopyEventLike,
  selection: SelectionSource | null,
  root: RootLike,
  lines: string[],
  joins: readonly RowJoin[],
  afterCopy: () => void,
  schedule: (task: () => void) => void = (task) => { setTimeout(task, 0) },
): boolean {
  if (!handleSnapshotCopy(event, selection, root, lines, joins)) return false
  schedule(afterCopy)
  return true
}
