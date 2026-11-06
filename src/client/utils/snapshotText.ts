/**
 * snapshotText - text shaping for the "Select text" snapshot layer.
 *
 * displaySnapshotText keeps one entry per captured line, so the layer can
 * align the visible screen with the terminal underneath. Copied text passes
 * through selectedSnapshotText, which first rejoins rows the app wrapped
 * itself (when given joins from snapshotRejoin.ts) and then normalises:
 *
 * - trailing whitespace is stripped per line;
 * - the indent common to the copied lines is removed, which drops the 2-column
 *   gutter Claude Code and Codex draw while keeping relative indentation
 *   inside code;
 * - leading and trailing blank lines are dropped.
 *
 * The layer always shows rows exactly as captured; only clipboard text is
 * rejoined.
 */

const TRAILING_WS = /[ \t ]+$/

/** Strip trailing whitespace per line but keep every line, blank or not. */
export function displaySnapshotText(text: string): string {
  return text.split('\n').map((line) => line.replace(TRAILING_WS, '')).join('\n')
}

const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * Clipboard text for `lines`. `startPrefix` is the part of the first line's
 * row that precedes the copied text. When it is blank (the copy starts in or
 * at the end of the indent) the first line counts toward the common indent
 * with its full row indent. When it holds text (the copy starts mid-line),
 * the first line has no real indent: it is left out of the common indent and
 * only loses its own leading spaces.
 */
export function normalizeSnapshotText(lines: string[], startPrefix = ''): string {
  const stripped = lines.map((line) => line.replace(TRAILING_WS, ''))
  const startsInIndent = startPrefix.trim() === ''
  if (stripped.length > 0 && startsInIndent && stripped[0] !== '') {
    stripped[0] = ' '.repeat(startPrefix.length) + stripped[0]
  }

  let common = Infinity
  stripped.forEach((line, index) => {
    if (line === '' || (index === 0 && !startsInIndent)) return
    common = Math.min(common, indentOf(line))
  })
  if (!Number.isFinite(common)) common = 0

  const out = stripped.map((line, index) => {
    if (line === '') return ''
    if (index === 0 && !startsInIndent) return line.trimStart()
    return line.slice(common)
  })
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** A non-blank prefix: marks a copy that starts mid-way through a line. */
const MID_LINE = '\u0000'

export interface SnapshotPoint {
  line: number
  /** Offset in that line's text; Infinity means the end of the line. */
  col: number
}

/**
 * Clipboard text for the span from `start` to `end` (either order) of `lines`.
 * With `joins` (see snapshotRejoin.ts), rows the app wrapped itself are
 * rejoined first, decided on the whole rows; then only the selected part is
 * kept and the common indent removed.
 */
export function selectedSnapshotText(
  lines: string[],
  start: SnapshotPoint,
  end: SnapshotPoint,
  joins: ReadonlyArray<' ' | '' | null> = [],
): string {
  if (lines.length === 0) return ''
  const before = start.line < end.line || (start.line === end.line && start.col <= end.col)
  const [from, to] = before ? [start, end] : [end, start]
  const first = Math.max(0, Math.min(from.line, lines.length - 1))
  const last = Math.max(first, Math.min(to.line, lines.length - 1))
  const startCol = from.line === first ? from.col : 0
  const endCol = to.line === last ? to.col : Infinity

  const out: string[] = []
  for (let row = first; row <= last; row++) {
    const fragment = lines[row].slice(row === first ? startCol : 0, row === last ? endCol : Infinity)
    const join = row > first ? joins[row - 1] ?? null : null
    if (join === null) out.push(fragment)
    else out[out.length - 1] = out[out.length - 1].trimEnd() + join + fragment.trimStart()
  }
  // A selection that starts on a continuation row starts mid-line.
  const continues = first > 0 && (joins[first - 1] ?? null) !== null
  const prefix = continues ? MID_LINE : lines[first].slice(0, startCol)
  return normalizeSnapshotText(out, prefix)
}
