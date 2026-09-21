import { describe, expect, test } from 'bun:test'
import { fetchPrInfo, parsePrUrl } from '../prInfo'

describe('parsePrUrl', () => {
  test('parses github PR urls', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/12')).toEqual({
      url: 'https://github.com/o/r/pull/12',
      repo: 'o/r',
      number: 12,
    })
  })

  test('rejects non-PR urls', () => {
    expect(parsePrUrl('https://github.com/o/r')).toBeNull()
    expect(parsePrUrl('https://github.com/o/r/pull/')).toBeNull()
    expect(parsePrUrl('https://evil.com/o/r/pull/1')).toBeNull()
    expect(parsePrUrl('not a url')).toBeNull()
    expect(parsePrUrl('')).toBeNull()
  })
})

describe('fetchPrInfo', () => {
  test('returns invalid-url errors without spawning gh', async () => {
    const res = await fetchPrInfo(['not a url'])
    expect(res).toEqual([{ url: 'not a url', error: 'invalid url' }])
  })
})
