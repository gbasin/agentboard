import { describe, expect, test } from 'bun:test'
import { detectsPermissionPrompt } from '../SessionManager'

describe('detectsPermissionPrompt', () => {
  test('matches prompts even with ansi escapes', () => {
    const content = [
      'some output',
      '\u001b[31m❯ 1. Yes\u001b[0m',
      '2. No',
    ].join('\n')

    expect(detectsPermissionPrompt(content)).toBe(true)
  })

  test('ignores prompts outside the recent window', () => {
    const lines = Array.from({ length: 31 }, (_, index) =>
      index === 0 ? 'Do you want to proceed?' : `line-${index}`
    )

    expect(detectsPermissionPrompt(lines.join('\n'))).toBe(false)
  })

  test('returns false when no prompts are present', () => {
    const content = ['hello', 'world', 'done'].join('\n')
    expect(detectsPermissionPrompt(content)).toBe(false)
  })

  test('matches AskUserQuestion selection menu', () => {
    const content = [
      'Which issue would you like me to investigate?',
      '',
      '❯ 1. Fix orphaned sessions',
      '     Update logPoller.ts to backfill lastUserMessage',
      '  2. Fix stale data check',
      '     Modify logMatchWorker.ts to re-extract when stored value might be wrong',
      '  3. Debug specific sessions',
      '  4. Add logging/diagnostics',
      '  5. Type something.',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    expect(detectsPermissionPrompt(content)).toBe(true)
  })
})
