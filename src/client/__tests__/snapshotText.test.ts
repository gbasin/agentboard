import { describe, expect, test } from 'bun:test'
import {
  cleanSnapshotText,
  displaySnapshotText,
  normalizeSnapshotText,
  selectedSnapshotText,
} from '../utils/snapshotText'
import {
  handleSnapshotCopy,
  resolveSnapshotPoint,
  snapshotCopyText,
  SNAPSHOT_LINE_ATTR,
} from '../utils/snapshotSelection'

// The Claude Code reply captured in the simulator: 2-column gutter, app-wrapped
// prose, and a code block whose long comment wraps back to the gutter.
const CLAUDE = [
  '  of the real one, and calls such as math.sqrt',
  '  will fail.',
  '',
  '  def sum_evens(numbers):',
  '      """Return the sum of the even values in ',
  '  numbers."""',
  '      total = 0  # running total, starts at zero',
  '          if n % 2 == 0:  # keep only even values',
  '              total = add(total, n)  # accumulate ',
  '  through add',
  '      return total  # final sum of the evens',
  '',
  '✻ Churned for 8s · done 8:19 AM',
]

describe('displaySnapshotText', () => {
  test('strips trailing whitespace but keeps every line', () => {
    expect(displaySnapshotText('a  \n\t\n b  \n')).toBe('a\n\n b\n')
  })
})

describe('normalizeSnapshotText', () => {
  test('removes the common gutter and keeps relative code indentation', () => {
    expect(normalizeSnapshotText(CLAUDE.slice(3, 11))).toBe([
      'def sum_evens(numbers):',
      '    """Return the sum of the even values in',
      'numbers."""',
      '    total = 0  # running total, starts at zero',
      '        if n % 2 == 0:  # keep only even values',
      '            total = add(total, n)  # accumulate',
      'through add',
      '    return total  # final sum of the evens',
    ].join('\n'))
  })

  test('blank lines do not count toward the indent and come out empty', () => {
    expect(normalizeSnapshotText(['    a', '   ', '      b', ''])).toBe('a\n\n  b')
  })

  test('drops leading and trailing blank lines', () => {
    expect(normalizeSnapshotText(['', '  ', '  x', '', '  '])).toBe('x')
    expect(normalizeSnapshotText(['', ' '])).toBe('')
    expect(normalizeSnapshotText([])).toBe('')
  })

  test('a mid-line start does not zero the indent of the following lines', () => {
    // Selection from "fail." in "  will fail." would read "fail." with no indent.
    expect(normalizeSnapshotText(['fail.', '', '  def f():', '      return 1'], '  will '))
      .toBe('fail.\n\ndef f():\n    return 1')
  })

  test('a mid-line start that lands on spaces loses only its own leading spaces', () => {
    expect(normalizeSnapshotText(['  runs when', '  next line'], 'Nothing')).toBe('runs when\nnext line')
  })

  test('a start inside the indent counts the full row indent', () => {
    // Selection starting at "def" (prefix is the 2-column gutter) or one
    // column into the gutter both match the whole-line result.
    const whole = normalizeSnapshotText(['  def f():', '      return 1'])
    expect(normalizeSnapshotText(['def f():', '      return 1'], '  ')).toBe(whole)
    expect(normalizeSnapshotText([' def f():', '      return 1'], ' ')).toBe(whole)
  })

  test('a first line deeper than the rest keeps its relative indent', () => {
    expect(normalizeSnapshotText(['total = 1', '  return total'], '      ')).toBe('    total = 1\nreturn total')
  })

  test('is idempotent and gives the same result for a single line', () => {
    const once = normalizeSnapshotText(CLAUDE)
    expect(normalizeSnapshotText(once.split('\n'))).toBe(once)
    expect(normalizeSnapshotText(['    only'])).toBe('only')
  })
})

describe('cleanSnapshotText', () => {
  test('Copy all keeps the gutter when an unindented line is in the capture', () => {
    const text = cleanSnapshotText(CLAUDE.join('\n') + '\n\n')
    expect(text.startsWith('  of the real one')).toBe(true)
    expect(text.endsWith('✻ Churned for 8s · done 8:19 AM')).toBe(true)
  })

  test('Copy all of an indented-only capture drops the gutter', () => {
    expect(cleanSnapshotText('  a\n    b\n')).toBe('a\n  b')
  })
})

describe('selectedSnapshotText', () => {
  test('a code block selected from "def" to the end of "evens"', () => {
    const end = { line: 10, col: CLAUDE[10].length }
    const text = selectedSnapshotText(CLAUDE, { line: 3, col: 2 }, end)
    expect(text.split('\n')[0]).toBe('def sum_evens(numbers):')
    expect(text.split('\n')[1]).toBe('    """Return the sum of the even values in')
    expect(text.split('\n').at(-1)).toBe('    return total  # final sum of the evens')
  })

  test('a paragraph selected mid-line', () => {
    expect(selectedSnapshotText(CLAUDE, { line: 0, col: 9 }, { line: 1, col: 12 }))
      .toBe('real one, and calls such as math.sqrt\nwill fail.')
  })

  test('within one line, reversed, and past the end', () => {
    expect(selectedSnapshotText(['  hello world'], { line: 0, col: 8 }, { line: 0, col: 2 })).toBe('hello')
    expect(selectedSnapshotText(['a', '  b'], { line: 0, col: 0 }, { line: 9, col: Infinity })).toBe('a\n  b')
    expect(selectedSnapshotText([], { line: 0, col: 0 }, { line: 0, col: 1 })).toBe('')
  })

  test('a selection that starts at the end of a line skips it', () => {
    expect(selectedSnapshotText(['  x', '  y', '    z'], { line: 0, col: Infinity }, { line: 2, col: Infinity }))
      .toBe('y\n  z')
  })
})

// Minimal DOM stand-ins: a root holding one element per line, each with one
// Text node.
function fakeLayer(lines: string[]) {
  const elements = lines.map((_, index) => {
    const element: Record<string, unknown> = {
      nodeType: 1,
      parentElement: null,
      getAttribute: (name: string) => name === SNAPSHOT_LINE_ATTR ? String(index) : null,
    }
    element.closest = () => element
    const textNode = { nodeType: 3, parentElement: element }
    return { element, textNode }
  })
  const root = { contains: (node: unknown) => elements.some((entry) => entry.element === node) }
  return { root, elements }
}

describe('snapshot selection mapping', () => {
  const lines = ['  def f():', '      return 1', '']
  const { root, elements } = fakeLayer(lines)

  test('resolves text, element and root boundaries', () => {
    expect(resolveSnapshotPoint(root, elements[1].textNode, 4, 3)).toEqual({ line: 1, col: 4 })
    expect(resolveSnapshotPoint(root, elements[2].element, 0, 3)).toEqual({ line: 2, col: 0 })
    expect(resolveSnapshotPoint(root, elements[2].element, 1, 3)).toEqual({ line: 2, col: Infinity })
    expect(resolveSnapshotPoint(root, root, 1, 3)).toEqual({ line: 1, col: 0 })
    expect(resolveSnapshotPoint(root, root, 3, 3)).toEqual({ line: 2, col: Infinity })
  })

  test('rejects boundaries outside the layer', () => {
    const stranger = { nodeType: 1, parentElement: null, closest: () => null, getAttribute: () => null }
    expect(resolveSnapshotPoint(root, stranger, 0, 3)).toBeNull()
    expect(resolveSnapshotPoint(root, null, 0, 3)).toBeNull()
    expect(resolveSnapshotPoint(root, root, 0, 0)).toBeNull()
  })

  test('maps a range to normalised text', () => {
    const range = { startContainer: elements[0].textNode, startOffset: 2, endContainer: elements[1].textNode, endOffset: 14 }
    expect(snapshotCopyText(root, range, lines)).toBe('def f():\n    return 1')
  })

  test('the copy handler writes the normalised text and cancels the default copy', () => {
    const written: Array<[string, string]> = []
    let prevented = false
    const event = { clipboardData: { setData: (type: string, data: string) => { written.push([type, data]) } }, preventDefault: () => { prevented = true } }
    const range = { startContainer: elements[0].textNode, startOffset: 2, endContainer: root, endOffset: 3 }
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range }
    expect(handleSnapshotCopy(event, selection, root, lines)).toBe(true)
    expect(prevented).toBe(true)
    expect(written).toEqual([['text/plain', 'def f():\n    return 1']])
  })

  test('the copy handler leaves selections elsewhere and empty ones alone', () => {
    let prevented = false
    const event = { clipboardData: { setData: () => {} }, preventDefault: () => { prevented = true } }
    const outside = { startContainer: {}, startOffset: 0, endContainer: {}, endOffset: 0 }
    expect(handleSnapshotCopy(event, { rangeCount: 1, isCollapsed: false, getRangeAt: () => outside }, root, lines)).toBe(false)
    expect(handleSnapshotCopy(event, { rangeCount: 1, isCollapsed: true, getRangeAt: () => outside }, root, lines)).toBe(false)
    expect(handleSnapshotCopy(event, null, root, lines)).toBe(false)
    expect(handleSnapshotCopy({ ...event, clipboardData: null }, { rangeCount: 1, isCollapsed: false, getRangeAt: () => outside }, root, lines)).toBe(false)
    expect(prevented).toBe(false)
  })
})
