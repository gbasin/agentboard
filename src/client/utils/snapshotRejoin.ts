/**
 * snapshotRejoin - finds the line breaks a TUI inserted itself, so copied
 * text from the "Select text" layer reads as the app's original lines.
 *
 * Claude Code and Codex word-wrap their output before it reaches the
 * terminal, so tmux's `capture-pane -J` cannot join those rows: they are real
 * newlines to tmux. A row was wrapped by the app when the first word of the
 * next row would not have fitted on it. The wrap width is measured from the
 * capture itself (the widest ordinary row), not hard-coded per app; both TUIs
 * measured at the full pane width on a 50-column pane.
 *
 * Joins are decided on whole captured rows; callers slice the selection
 * afterwards. Plain shells must not use this: there `-J` is already exact.
 */

/** Rows wider than this many columns short of the pane prove nothing. */
const WIDTH_EVIDENCE_SLACK = 2

/** Box drawing and block elements: tables, borders and the prompt box. */
const BOX_DRAWING = /[─-▟]/
/** A row that opens a list item or bullet (after its indent). */
const LIST_ITEM = /^\s*(?:[-*+•●◦▪‣⏺›❯>]|\d+[.)])\s/
/**
 * A first word that reads as a code statement (`print(total)`, `x=1`,
 * `items[0]`): a wrapped comment or sentence never continues with one.
 */
const CODE_STATEMENT = /\w[([{]|\w=/
/** Where a long token (URL, path, hyphenated word) is broken without a space. */
const TOKEN_BREAK_END = /(?:[/?&=#]|\w-)$/

/** Terminal column width of one code point (wide East Asian and emoji = 2). */
function codePointWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2
  return 1
}

/** Display width of `text` in terminal columns. */
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) width += codePointWidth(char.codePointAt(0) ?? 0)
  return width
}

const isOrdinaryRow = (row: string, paneCols: number) =>
  row.trim() !== '' && !BOX_DRAWING.test(row) && displayWidth(row) <= paneCols

/**
 * The column the app wrapped at: the widest ordinary row, when some row comes
 * within WIDTH_EVIDENCE_SLACK of the pane width. Without such evidence (a
 * short capture) assume the full pane width, which only ever means fewer
 * joins, never wrong ones from an underestimate.
 */
export function inferWrapWidth(rows: string[], paneCols: number): number {
  let widest = 0
  for (const row of rows) {
    if (isOrdinaryRow(row, paneCols)) widest = Math.max(widest, displayWidth(row.trimEnd()))
  }
  return widest >= paneCols - WIDTH_EVIDENCE_SLACK ? widest : paneCols
}

/** How rows i and i+1 join: ' ' (wrapped at a space), '' (token broken), or null. */
export type RowJoin = ' ' | '' | null

/**
 * For each pair of adjacent rows, whether the app wrapped row i into row i+1.
 * Never joins across blank rows, box drawing, rows wider than the pane (tmux
 * already joined those), into a row that starts a list item, or (unless a
 * long token was broken) into a row that starts with a code statement.
 */
export function findWrappedRows(rows: string[], paneCols: number, wrapWidth = inferWrapWidth(rows, paneCols)): RowJoin[] {
  const joins: RowJoin[] = []
  for (let i = 0; i + 1 < rows.length; i++) {
    const row = rows[i].trimEnd()
    const next = rows[i + 1]
    if (!isOrdinaryRow(row, paneCols) || !isOrdinaryRow(next, paneCols) || LIST_ITEM.test(next)) {
      joins.push(null)
      continue
    }
    const rowWidth = displayWidth(row)
    const nextWord = next.trimStart().split(/\s/, 1)[0]
    if (rowWidth + 1 + displayWidth(nextWord) <= wrapWidth) {
      joins.push(null)
      continue
    }
    // A long token (URL, path) is broken without a space: the row is one
    // token, or ends on a URL/path separator or a word hyphen. A row that
    // merely fills the width is not enough: both TUIs fill rows exactly to
    // the width with whole words.
    const content = row.trimStart()
    const brokenToken = !/\s/.test(content) || TOKEN_BREAK_END.test(content)
    if (!brokenToken && CODE_STATEMENT.test(nextWord)) {
      joins.push(null)
      continue
    }
    joins.push(brokenToken ? '' : ' ')
  }
  return joins
}
