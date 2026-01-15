import { describe, expect, test } from 'bun:test'
import { getSessionIdShort } from '../utils/sessionId'

describe('sessionId utils', () => {
  test('getSessionIdShort trims and shortens long ids', () => {
    expect(getSessionIdShort('  abcdef123456  ')).toBe('abc…456')
  })

  test('getSessionIdShort returns short ids unchanged', () => {
    expect(getSessionIdShort('abc')).toBe('abc')
    expect(getSessionIdShort('abcdef')).toBe('abcdef')
  })
})
