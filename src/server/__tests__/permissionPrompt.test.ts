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
    const lines = Array.from({ length: 11 }, (_, index) =>
      index === 0 ? 'Do you want to proceed?' : `line-${index}`
    )

    expect(detectsPermissionPrompt(lines.join('\n'))).toBe(false)
  })

  test('returns false when no prompts are present', () => {
    const content = ['hello', 'world', 'done'].join('\n')
    expect(detectsPermissionPrompt(content)).toBe(false)
  })

  test('does not match "1. Allow" appearing mid-sentence', () => {
    const content = [
      '3. **fix: prevent false positive permission detection**',
      '   - Regex was matching "1. Allow" in regular numbered lists',
      '   - Added fix to require start of line',
    ].join('\n')
    expect(detectsPermissionPrompt(content)).toBe(false)
  })

  test('matches Devin CLI approval menu', () => {
    const content = [
      'Devin wants to run: rm -rf build/',
      '',
      '  Approve once',
      '  This session',
      '  Auto-approve edits in workspace dirs',
      '  Deny',
    ].join('\n')

    expect(detectsPermissionPrompt(content)).toBe(true)
  })

  test('matches Devin network permission prompt', () => {
    const content = ['Allow api.example.com?', '  Yes, allow once', '  No, deny'].join(
      '\n'
    )

    expect(detectsPermissionPrompt(content)).toBe(true)
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

  test('matches tall AskUserQuestion card via footer when ❯ scrolls out', () => {
    const content = [
      'Which hosted substrate should run the iOS simulator lane?',
      '',
      '❯ 1. EAS Workflows maestro job (Recommended)',
      '     Expo builds the simulator app and runs Maestro flows with shards',
      '     + retries, $0.075/min + $0.05/job, YAML-driven. No runner upkeep.',
      '  2. Expand GitHub Actions macOS',
      '     Grow ios-smoke from nightly evidence into a PR or merge-queue',
      '     lane. $0.062/min, full shell control (notifyutil, simctl push).',
      '  3. Appetize.io streamed simulators',
      '     $59/mo, Playwright SDK, biometry() built in.',
      '  4. Maestro Cloud hosted devices',
      '     $250/device/mo, unlimited runs, AI assertions included.',
      '  5. Type something.',
      '  6. Chat about this',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n')

    expect(detectsPermissionPrompt(content)).toBe(true)
  })
})
