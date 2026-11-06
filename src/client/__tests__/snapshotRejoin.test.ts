import { describe, expect, test } from 'bun:test'
import { displayWidth, findWrappedRows, inferWrapWidth } from '../utils/snapshotRejoin'
import { selectedSnapshotText } from '../utils/snapshotText'
// Real 50-column captures (rows right-trimmed, blank runs collapsed) of
// fullscreen Claude Code 2.1.319 and Codex 0.167.0 answering one prompt: a
// paragraph, a code block with wrapped trailing comments, a long URL, a
// bulleted list and a table.
import captures from './fixtures/tuiWrapCaptures.json'

const CLAUDE: string[] = captures.cfull
const CODEX: string[] = captures.codex
const COLS = 50

/** Copy rows [from, to] whole, the way a full-line selection would. */
function copy(rows: string[], from: string, to: string) {
  const first = rows.findIndex((row) => row.includes(from))
  const last = rows.findIndex((row, index) => index >= first && row.includes(to))
  expect(first).toBeGreaterThanOrEqual(0)
  expect(last).toBeGreaterThanOrEqual(first)
  return selectedSnapshotText(rows, { line: first, col: 0 }, { line: last, col: Infinity }, findWrappedRows(rows, COLS))
}

describe('displayWidth', () => {
  test('counts terminal columns, not code units', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('日本語')).toBe(6)
    expect(displayWidth('😀x')).toBe(3)
    expect(displayWidth('é')).toBe(1)
    expect(displayWidth('──')).toBe(2)
  })
})

describe('inferWrapWidth', () => {
  test('both TUIs wrap at the full pane width', () => {
    expect(inferWrapWidth(CLAUDE, COLS)).toBe(50)
    expect(inferWrapWidth(CODEX, COLS)).toBe(50)
  })

  test('falls back to the pane width without evidence, never below it', () => {
    expect(inferWrapWidth(['short', 'rows only'], COLS)).toBe(COLS)
    expect(inferWrapWidth(['x'.repeat(49)], COLS)).toBe(49)
    // Box drawing and rows tmux already joined are not evidence.
    expect(inferWrapWidth(['─'.repeat(50), 'y'.repeat(80), 'z'.repeat(30)], COLS)).toBe(COLS)
  })
})

describe('findWrappedRows on Claude Code', () => {
  test('rejoins a wrapped paragraph into one line', () => {
    expect(copy(CLAUDE, 'I have not opened math.py', 'is renamed.')).toBe(
      '⏺ I have not opened math.py in this session, so this paragraph describes it only in general ' +
      'terms. A file with that name usually holds small arithmetic helpers such as add and subtract ' +
      'functions. One caution applies regardless of contents: a module named math.py shadows the ' +
      'Python standard library math module for any script run from the same directory, which can ' +
      'produce confusing import errors until the file is renamed.')
  })

  test('rejoins wrapped trailing comments and leaves short code lines alone', () => {
    expect(copy(CLAUDE, 'from operator import add', 'print(doubled)')).toBe([
      'from operator import add',
      'values = [2, 3]',
      'total = add(*values)  # Python integers never overflow, so no bounds check is needed',
      'doubled = add(total, total)  # adding the total to itself doubles it without multiplication',
      'print(total)',
      'print(doubled)',
    ].join('\n'))
  })

  test('rejoins a URL broken mid-token without spaces', () => {
    expect(copy(CLAUDE, 'https://example.com/a/very/long/path/that/keeps/', '=one&other=two')).toBe(
      'https://example.com/a/very/long/path/that/keeps/going/and/going/for/testing/wrap/behaviour?query=one&other=two')
  })

  test('rejoins each wrapped bullet but keeps the items apart', () => {
    const text = copy(CLAUDE, 'Integer addition is commutative', 'edge-case test in the suite.')
    expect(text.split('\n')).toEqual([
      '- Integer addition is commutative, so swapping the two operands never changes the result, which lets a test suite check both argument orders with one expected value.',
      '- Python integers grow to arbitrary precision, so adding very large values produces an exact answer instead of wrapping around as fixed-width integers do in C.',
      '- Zero is the additive identity, meaning any integer plus zero returns that same integer, a property worth covering with a dedicated edge-case test in the suite.',
    ])
  })

  test('leaves a table, the prompt box and the status line untouched', () => {
    const tableRows = CLAUDE.filter((row) => row.includes('│') || row.includes('┌') || row.includes('└') || row.includes('├'))
    expect(copy(CLAUDE, '┌──', '└──').split('\n')).toEqual(tableRows.map((row) => row.slice(2)))
    const box = CLAUDE.slice(-4)
    expect(findWrappedRows(box, COLS)).toEqual([null, null, null])
  })

  test('rejoins the wrapped prompt echo, including its URL', () => {
    expect(copy(CLAUDE, 'verbatim and not as a markdown link:', 'integer addition.')).toBe(
      'verbatim and not as a markdown link: https://example.com/a/very/long/path/that/keeps/going/and/going/for/testing/wrap/behaviour?query=one&other=two (4) a bulleted list of 3 items where each item is about 25 words; (5) a markdown table with 3 columns and 3 rows about integer addition.')
  })
})

describe('findWrappedRows on Codex', () => {
  test('rejoins a wrapped paragraph, including rows that fill the width exactly', () => {
    const text = copy(CODEX, 'math.py can serve as a small', 'learning basic Python.')
    expect(text).not.toContain('\n')
    expect(text).toContain('functions that add integers and return')
    expect(text).toContain('A clear implementation keeps')
    expect(text).toContain('cover positive values')
  })

  test('rejoins wrapped trailing comments in a code block', () => {
    expect(copy(CODEX, 'def add(left: int', 'print(first, second)')).toBe([
      'def add(left: int, right: int) -> int:',
      '    """Return the sum of two integers."""',
      '    return left + right  # Add both integers directly without changing either input.',
      'first = add(3, 4)',
      'second = add(-2, 2)  # Equal opposite integers produce zero through cancellation.',
      'print(first, second)',
    ].join('\n'))
  })

  test('rejoins a URL broken at separators below the full width', () => {
    expect(copy(CODEX, 'https://example.com/a/very/long/path/that/keeps/', 'query=one&other=two')).toBe(
      'https://example.com/a/very/long/path/that/keeps/going/and/going/for/testing/wrap/behaviour?query=one&other=two')
  })

  test('rejoins wrapped bullets with blank rows between items', () => {
    expect(copy(CODEX, '• Adding zero preserves', 'examples.')).toBe(
      '• Adding zero preserves the original integer, which makes zero useful when checking that an addition function handles an unchanged quantity correctly across several different examples.')
  })

  test('leaves the table rows apart', () => {
    const text = copy(CODEX, 'First integer', '-2               2')
    expect(text.split('\n')).toHaveLength(7)
  })

  test('rejoins help text that wraps back to column 0', () => {
    expect(copy(CODEX, 'To get started', 'these commands:')).toBe('To get started, describe a task or try one of these commands:')
    expect(copy(CODEX, '/permissions', 'do')).toBe('/permissions - choose what Codex is allowed to do')
  })
})

describe('findWrappedRows guards and known limits', () => {
  test('never joins across blank rows, into list items, or rows tmux already joined', () => {
    const long = 'x'.repeat(48)
    expect(findWrappedRows([long, '', 'wordy'], COLS)).toEqual([null, null])
    expect(findWrappedRows([long, '- item'], COLS)).toEqual([null])
    expect(findWrappedRows([long, '12. item'], COLS)).toEqual([null])
    expect(findWrappedRows(['y'.repeat(80), 'continued'], COLS)).toEqual([null])
    expect(findWrappedRows([long + ' │', 'next'], COLS)).toEqual([null])
  })

  test('joins a hyphen break without a space', () => {
    expect(findWrappedRows(['  the result of a long and carefully argued self-', '  evident claim'], COLS)).toEqual([''])
  })

  test('a docstring wrapped before its closing quotes comes back as one line', () => {
    // Claude Code, earlier 50-column capture.
    const rows = ['  def sum_evens(numbers):', '      """Return the sum of the even values in', '  numbers."""']
    expect(selectedSnapshotText(rows, { line: 0, col: 0 }, { line: 2, col: Infinity }, findWrappedRows(rows, COLS)))
      .toBe('def sum_evens(numbers):\n    """Return the sum of the even values in numbers."""')
  })

  test('a code statement after a full row is not treated as a continuation', () => {
    // Seen live: "...without multiplication" (45 columns) then "print(total)".
    const rows = ['  to itself doubles it without multiplication', '  print(total)']
    expect(findWrappedRows(rows, COLS)).toEqual([null])
  })

  test('KNOWN WRONG: a real line break near the edge followed by a plain long word is joined', () => {
    // A line that genuinely ends near the width followed by an unrelated line
    // whose first word does not fit and does not look like code.
    const rows = ['  doubled = add(total, total)  # adding the total', '  return total']
    expect(findWrappedRows(rows, COLS)).toEqual([' '])
  })

  test('KNOWN WRONG: a row the app wrapped short of the width with a short next word is missed', () => {
    // Claude's prompt echo wraps one column narrower than its answers, so
    // "paragraph" + "of" (2 columns) still fits the inferred width of 50.
    const rows = ['  parts in order: (1) one plain prose paragraph', '  of about 70 words about math.py; (2) a fenced']
    expect(findWrappedRows(rows, COLS)).toEqual([null])
  })
})

describe('selectedSnapshotText with joins', () => {
  test('decides on whole rows and emits only the selected part', () => {
    const rows = CLAUDE
    const first = rows.findIndex((row) => row.includes('total = add(*values)'))
    const joins = findWrappedRows(rows, COLS)
    // From "never" on the first row to "bounds" on its continuation.
    const start = { line: first, col: rows[first].indexOf('never') }
    const end = { line: first + 1, col: rows[first + 1].indexOf('bounds') + 'bounds'.length }
    expect(selectedSnapshotText(rows, start, end, joins)).toBe('never overflow, so no bounds')
  })

  test('a selection starting on a continuation row counts as mid-line', () => {
    const rows = ['  first part of a sentence that was wrapped here', '  continuation', '      indented code']
    const joins: Array<' ' | '' | null> = [' ', null]
    expect(selectedSnapshotText(rows, { line: 1, col: 0 }, { line: 2, col: Infinity }, joins))
      .toBe('continuation\nindented code')
  })

  test('without joins rows are copied as shown', () => {
    expect(selectedSnapshotText(['  a wrapped', '  row'], { line: 0, col: 0 }, { line: 1, col: Infinity })).toBe('a wrapped\nrow')
  })
})
