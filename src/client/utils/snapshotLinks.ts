/** Detect explicit web URLs without changing captured rows or their offsets. */
import type { RowJoin } from './snapshotRejoin'

export interface SnapshotLink { start: number; end: number; href: string }

export function snapshotLinks(lines: string[], joins: readonly RowJoin[]): SnapshotLink[][] {
  const result: SnapshotLink[][] = lines.map(() => [])
  for (let first = 0; first < lines.length;) {
    let last = first
    let text = lines[first]
    const rows = [{ line: first, offset: 0, indent: 0 }]
    while (joins[last] === '' && last + 1 < lines.length) {
      last++
      const indent = lines[last].length - lines[last].trimStart().length
      rows.push({ line: last, offset: text.length, indent })
      text += lines[last].slice(indent)
    }
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
      // A terminal truncation marker cannot identify a navigable destination.
      if (match[0].includes('…') || /\.{3}(?:[)\].,;:]*)$/.test(match[0])) continue
      let url = match[0].replace(/[.,;:!?]+$/, '')
      // Keep balanced parentheses in paths, but not prose/Markdown wrappers.
      for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
        while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1)
      }
      try { if (!new URL(url).hostname) continue } catch { continue }
      const start = match.index!
      const end = start + url.length
      rows.forEach((row, index) => {
        const rowEnd = rows[index + 1]?.offset ?? text.length
        const from = Math.max(start, row.offset)
        const to = Math.min(end, rowEnd)
        if (from < to) result[row.line].push({ start: from - row.offset + row.indent, end: to - row.offset + row.indent, href: url })
      })
    }
    first = last + 1
  }
  return result
}
