import { describe, expect, test } from 'bun:test'
import { bracketedPaste, imagePathInput } from '../utils/paste'

describe('bracketedPaste', () => {
  test('wraps text in bracketed-paste markers', () => {
    expect(bracketedPaste('/tmp/x.png')).toBe('\x1b[200~/tmp/x.png\x1b[201~')
  })

  test('handles empty text', () => {
    expect(bracketedPaste('')).toBe('\x1b[200~\x1b[201~')
  })
})

describe('imagePathInput', () => {
  test('brackets the path for Claude so it attaches the image', () => {
    expect(imagePathInput('/tmp/x.png', 'claude')).toBe('\x1b[200~/tmp/x.png\x1b[201~')
  })

  test('brackets the path for an unknown agent', () => {
    expect(imagePathInput('/tmp/x.png', undefined)).toBe('\x1b[200~/tmp/x.png\x1b[201~')
  })

  test('sends the raw path for Codex (native clipboard paste)', () => {
    expect(imagePathInput('/tmp/x.png', 'codex')).toBe('/tmp/x.png')
  })
})
