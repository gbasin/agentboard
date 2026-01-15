import { describe, expect, test } from 'bun:test'
import {
  cleanTmuxLine,
  isDecorativeLine,
  isMetadataLine,
  stripAnsi,
  TMUX_METADATA_MATCH_PATTERNS,
  TMUX_METADATA_STATUS_PATTERNS,
} from '../terminal/tmuxText'

describe('tmuxText helpers', () => {
  test('stripAnsi removes escape codes', () => {
    const input = '\u001b[31mRed\u001b[0m Text'
    expect(stripAnsi(input)).toBe('Red Text')
  })

  test('detects decorative lines', () => {
    expect(isDecorativeLine('───────')).toBe(true)
    expect(isDecorativeLine('normal output')).toBe(false)
  })

  test('detects metadata lines with provided patterns', () => {
    expect(isMetadataLine('Todos: review output', TMUX_METADATA_MATCH_PATTERNS)).toBe(
      true
    )
    expect(
      isMetadataLine('ESC to interrupt', TMUX_METADATA_STATUS_PATTERNS)
    ).toBe(true)
    expect(isMetadataLine('regular prompt', TMUX_METADATA_STATUS_PATTERNS)).toBe(
      false
    )
  })

  test('cleanTmuxLine removes timers, glyphs, and extra spaces', () => {
    const line = '\u001b[31m❯  run tests (12s remaining)  ⏵  '
    expect(cleanTmuxLine(line)).toBe('run tests')
  })
})
