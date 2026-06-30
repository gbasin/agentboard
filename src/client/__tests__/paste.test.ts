import { describe, expect, test } from 'bun:test'
import { bracketedPaste, imagePathInput, sanitizeImagePath } from '../utils/paste'

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

  test('strips control characters before wrapping so a crafted path cannot break out', () => {
    // A filename embedding the bracketed-paste end marker + escape sequence.
    const malicious = '/tmp/a\x1b[201~\x1b[31mevil.png'
    expect(imagePathInput(malicious, 'claude')).toBe('\x1b[200~/tmp/a[201~[31mevil.png\x1b[201~')
  })

  test('strips control characters for Codex raw paths too', () => {
    expect(imagePathInput('/tmp/a\x07b.png', 'codex')).toBe('/tmp/ab.png')
  })
})

describe('sanitizeImagePath', () => {
  test('removes C0 control characters and DEL', () => {
    expect(sanitizeImagePath('/tmp/\x00\x1b\x07\x7fok.png')).toBe('/tmp/ok.png')
  })

  test('leaves ordinary paths (incl. spaces) untouched', () => {
    expect(sanitizeImagePath('/Users/me/My Screenshot.png')).toBe('/Users/me/My Screenshot.png')
  })
})
