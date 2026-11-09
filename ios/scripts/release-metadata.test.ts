import { describe, expect, test } from 'bun:test'
import { releaseMetadata } from './release-metadata'

describe('iOS publishing identity', () => {
  test('manual builds and tags retain the iOS version; attempts never reuse a build', () => {
    expect(releaseMetadata('0.1.0\n', 'master', 1, 1)).toEqual({ version: '0.1.0', build: '1001.1' })
    expect(releaseMetadata('0.2.0', 'ios-v0.2.0', 2, 2)).toEqual({ version: '0.2.0', build: '1002.2' })
    expect(releaseMetadata('0.2.0', 'ios-v0.2.0', 8999, 99).build).toBe('9999.99')
  })
  test('rejects a mislabeled tag and invalid Apple version/build fields', () => {
    expect(() => releaseMetadata('0.2.0', 'ios-v0.1.0', 1, 1)).toThrow('tag')
    expect(() => releaseMetadata('0.2.0-beta', 'master', 1, 1)).toThrow('version')
    for (const run of [0, 9000, NaN, 1.5]) expect(() => releaseMetadata('0.1.0', 'master', run, 1)).toThrow()
    for (const attempt of [0, 100, NaN, 1.5]) expect(() => releaseMetadata('0.1.0', 'master', 1, attempt)).toThrow()
  })
})
