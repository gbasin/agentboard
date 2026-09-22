import { describe, expect, test } from 'bun:test'
import { fetchPrInfo, mapCheck, parsePrUrl } from '../prInfo'

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

describe('mapCheck', () => {
  test('passes check runs through with detailsUrl', () => {
    expect(
      mapCheck({
        name: 'ci',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/o/r/actions/runs/1',
      })
    ).toEqual({
      name: 'ci',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      link: 'https://github.com/o/r/actions/runs/1',
    })
  })

  test('keeps in-progress check runs pending', () => {
    expect(
      mapCheck({ name: 'ci', status: 'IN_PROGRESS', conclusion: null })
    ).toEqual({
      name: 'ci',
      status: 'IN_PROGRESS',
      conclusion: null,
      link: undefined,
    })
  })

  test('normalizes status contexts from state', () => {
    expect(
      mapCheck({
        context: 'lint',
        state: 'FAILURE',
        targetUrl: 'https://ci.example.com/1',
      })
    ).toEqual({
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      link: 'https://ci.example.com/1',
    })
  })

  test('treats pending/expected contexts as in-progress', () => {
    for (const state of ['PENDING', 'EXPECTED']) {
      expect(mapCheck({ context: 'ci', state })).toEqual({
        name: 'ci',
        status: 'IN_PROGRESS',
        conclusion: null,
        link: undefined,
      })
    }
  })
})
