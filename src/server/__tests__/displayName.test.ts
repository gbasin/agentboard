import { describe, expect, test } from 'bun:test'
import { resolveExternalDisplayName } from '../displayName'

describe('resolveExternalDisplayName', () => {
  test('returns session name when preferWindowName is false', () => {
    expect(resolveExternalDisplayName('dev', 'myapp', false)).toBe('dev')
  })

  test('returns window name when preferWindowName is true and distinct', () => {
    expect(resolveExternalDisplayName('dev', 'myapp', true)).toBe('myapp')
  })

  test('falls back to session name when window name equals session name', () => {
    expect(resolveExternalDisplayName('dev', 'dev', true)).toBe('dev')
  })

  test('falls back to session name when window name is empty', () => {
    expect(resolveExternalDisplayName('dev', '', true)).toBe('dev')
  })

  test('falls back to session name when window name is undefined', () => {
    expect(resolveExternalDisplayName('dev', undefined, true)).toBe('dev')
  })

  test('trims whitespace and falls back when window name is whitespace-only', () => {
    expect(resolveExternalDisplayName('dev', '   ', true)).toBe('dev')
  })

  test('trims whitespace from window name when distinct', () => {
    expect(resolveExternalDisplayName('dev', '  myapp  ', true)).toBe('myapp')
  })
})
