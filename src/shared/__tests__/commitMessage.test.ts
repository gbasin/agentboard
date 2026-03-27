import { describe, expect, test } from 'bun:test'
import {
  normalizeCommitMessage,
  parseCommitMessage,
  type CommitMessageValidationErrorCode,
} from '../commitMessage'

function expectInvalid(
  message: string,
  code: CommitMessageValidationErrorCode
) {
  const result = normalizeCommitMessage(message)
  expect(result.ok).toBe(false)
  if (result.ok) {
    throw new Error('Expected commit message to be invalid')
  }
  expect(result.error.code).toBe(code)
}

describe('commitMessage', () => {
  test('keeps an already valid commit message unchanged', () => {
    const message = 'fix(server): preserve websocket state\n\nBody stays the same.\n'
    const result = normalizeCommitMessage(message)

    expect(result).toMatchObject({
      ok: true,
      mode: 'normalized',
      changed: false,
      normalizedMessage: message,
    })
  })

  test('normalizes type, scope, whitespace, and colon spacing', () => {
    const result = normalizeCommitMessage(
      '  FIX ( Server/Core ) :   tighten reconnect handling  '
    )

    expect(result).toMatchObject({
      ok: true,
      mode: 'normalized',
      changed: true,
      normalizedMessage: 'fix(server/core): tighten reconnect handling',
    })
  })

  test('supports no-scope and breaking-change headers', () => {
    const result = normalizeCommitMessage(
      '  FEAT ! : remove legacy websocket fallback '
    )

    expect(result).toMatchObject({
      ok: true,
      mode: 'normalized',
      normalizedMessage: 'feat!: remove legacy websocket fallback',
    })
  })

  test('preserves body and trailers verbatim while normalizing only the header', () => {
    const message = [
      ' Docs ( README ) :  clarify install steps ',
      '',
      'Keep this body line exactly as written.  ',
      '',
      'Nightshift-Task: commit-normalize',
      'Nightshift-Ref: https://github.com/marcus/nightshift',
      '',
    ].join('\n')

    const result = normalizeCommitMessage(message)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('Expected commit message normalization to succeed')
    }

    expect(result.normalizedMessage).toBe(
      [
        'docs(readme): clarify install steps',
        '',
        'Keep this body line exactly as written.  ',
        '',
        'Nightshift-Task: commit-normalize',
        'Nightshift-Ref: https://github.com/marcus/nightshift',
        '',
      ].join('\n')
    )
  })

  test('passes through git-generated merge commit subjects unchanged', () => {
    const message = "Merge branch 'feature/terminal-resize' into master\n"
    const result = normalizeCommitMessage(message)

    expect(result).toMatchObject({
      ok: true,
      mode: 'passthrough',
      changed: false,
      normalizedMessage: message,
      generated: {
        kind: 'merge',
      },
    })
  })

  test('passes through git-generated revert commit subjects unchanged', () => {
    const message = [
      'Revert "feat(client): add persistent split view"',
      '',
      'This reverts commit 0123456789abcdef0123456789abcdef01234567.',
      '',
    ].join('\n')
    const result = normalizeCommitMessage(message)

    expect(result).toMatchObject({
      ok: true,
      mode: 'passthrough',
      changed: false,
      normalizedMessage: message,
      generated: {
        kind: 'revert',
      },
    })
  })

  test('passes through git autosquash subjects unchanged', () => {
    const cases = [
      {
        kind: 'fixup',
        message: 'fixup! feat(client): add persistent split view',
      },
      {
        kind: 'squash',
        message: 'squash! feat(client): add persistent split view',
      },
      {
        kind: 'amend',
        message: 'amend! feat(client): add persistent split view',
      },
    ] as const

    for (const testCase of cases) {
      const result = normalizeCommitMessage(testCase.message)

      expect(result).toMatchObject({
        ok: true,
        mode: 'passthrough',
        changed: false,
        normalizedMessage: testCase.message,
        generated: {
          kind: testCase.kind,
        },
      })
    }
  })

  test('parses valid commit headers for downstream consumers', () => {
    const result = parseCommitMessage('fix(ci)!: harden release permissions')

    expect(result).toMatchObject({
      ok: true,
      parsed: {
        type: 'fix',
        scope: 'ci',
        isBreakingChange: true,
        subject: 'harden release permissions',
      },
    })
  })

  test('rejects freeform subjects instead of guessing intent', () => {
    expectInvalid('Update release workflow', 'invalid_header')
  })

  test('rejects unsupported types', () => {
    expectInvalid('feature: add commit normalizer', 'unsupported_type')
  })

  test('rejects scopes that are not safely normalizable', () => {
    expectInvalid('fix(UI shell): tighten layout', 'invalid_scope')
  })

  test('rejects headers without subject text', () => {
    expectInvalid('fix(scope):   ', 'missing_subject')
  })

  test('rejects empty commit subjects', () => {
    expectInvalid('   \n\nBody', 'empty_message')
  })
})
