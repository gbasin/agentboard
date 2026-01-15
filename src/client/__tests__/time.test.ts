import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { formatRelativeTime } from '../utils/time'

const originalNow = Date.now

beforeAll(() => {
  Date.now = () => Date.parse('2025-01-02T00:00:00.000Z')
})

afterAll(() => {
  Date.now = originalNow
})

describe('formatRelativeTime', () => {
  test('returns empty string for invalid timestamps', () => {
    expect(formatRelativeTime('not-a-date')).toBe('')
  })

  test('returns now for under a minute', () => {
    expect(formatRelativeTime('2025-01-02T00:00:30.000Z')).toBe('now')
  })

  test('formats minutes and hours', () => {
    expect(formatRelativeTime('2025-01-01T23:10:00.000Z')).toBe('50m')
    expect(formatRelativeTime('2025-01-01T10:00:00.000Z')).toBe('14h')
  })

  test('formats days for long ranges', () => {
    expect(formatRelativeTime('2024-12-31T00:00:00.000Z')).toBe('2d')
  })
})
