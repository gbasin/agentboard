import { expect, test } from 'bun:test'
import { linkPresentation } from '../lib/linkPresentation'

test('bare and URL-labelled links display their destination once', () => {
  for (const label of [undefined, 'https://example.com/report', 'example.com/report']) {
    expect(linkPresentation('https://example.com/report', label)).toEqual({ title: 'example.com/report', subtitle: undefined, detail: '' })
  }
  expect(linkPresentation('https://example.com/', 'example.com').subtitle).toBeUndefined()
})
test('descriptive labels keep the destination, without hiding query and fragment differences', () => {
  expect(linkPresentation('https://example.com/report?rev=2#result', 'Review report')).toEqual({
    title: 'Review report', subtitle: 'example.com/report', detail: '?rev=2#result',
  })
  expect(linkPresentation('http://example.com/report').title).toBe('http://example.com/report')
  expect(linkPresentation('https://example.com/report?rev=3').detail).toBe('?rev=3')
})
test('GitHub PR labels preserve owner, subpage, query and comment identity', () => {
  expect(linkPresentation('https://github.com/geteichler/eichler/pull/2857#issuecomment-123')).toEqual({
    title: 'eichler · PR #2857', subtitle: 'github.com/geteichler', detail: 'Comment #123',
  })
  expect(linkPresentation('https://github.com/a/b/pull/1/files?diff=split#diff-abc').detail).toBe('/files · ?diff=split · #diff-abc')
  expect(linkPresentation('https://github.com/a/b/pull/1', 'Fix layout').title).toBe('Fix layout')
  expect(linkPresentation('https://github.com.evil.test/a/b/pull/1').title).toContain('github.com.evil.test')
  expect(linkPresentation('http://github.com/a/b/pull/1').title).toStartWith('http://')
})

test('raw unicode and empty delimiters do not truncate the displayed path', () => {
  expect(linkPresentation('https://example.com/report?q=café#')).toEqual({ title: 'example.com/report', subtitle: undefined, detail: '?q=café#' })
  expect(linkPresentation('https://example.com/report?').detail).toBe('?')
})
