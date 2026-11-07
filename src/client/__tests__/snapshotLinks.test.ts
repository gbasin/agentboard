import { expect, test } from 'bun:test'
import { snapshotLinks } from '../utils/snapshotLinks'

test('links explicit URLs, trims prose punctuation, preserves balanced paths', () => {
  const line = 'See (https://example.com/a_(b)), http://localhost:4040/?a=1&b=2#c. <script>'
  const links = snapshotLinks([line], [])[0]
  expect(links.map(l => l.href)).toEqual(['https://example.com/a_(b)', 'http://localhost:4040/?a=1&b=2#c'])
  expect(links.map(l => line.slice(l.start, l.end))).toEqual(links.map(l => l.href))
})

test('maps joined URL fragments back to original rows without linking indentation', () => {
  expect(snapshotLinks(['See https://example.com/', '  path#comment'], [''])).toEqual([
    [{ start: 4, end: 24, href: 'https://example.com/path#comment' }],
    [{ start: 2, end: 14, href: 'https://example.com/path#comment' }],
  ])
})

test('does not join hard newlines or guess unsafe, incomplete, or implicit URLs', () => {
  expect(snapshotLinks(['javascript:alert(1) file:///tmp/a www.example.com https:// https://foo… https://foo...'], [])[0]).toEqual([])
  expect(snapshotLinks(['https://example.com/', 'next'], [null])[0][0].href).toBe('https://example.com/')
})
