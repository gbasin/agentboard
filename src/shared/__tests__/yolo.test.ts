import { describe, expect, test } from 'bun:test'
import {
  addYoloFlag,
  commandHasYoloFlag,
  removeYoloFlag,
  yoloFlagFor,
  yoloFlagForCommand,
} from '../yolo'

describe('yoloFlagFor', () => {
  test('maps each agent family to its flag', () => {
    expect(yoloFlagFor('claude')).toBe('--dangerously-skip-permissions')
    expect(yoloFlagFor('claude-rp')).toBe('--dangerously-skip-permissions')
    expect(yoloFlagFor('codex')).toBe('--yolo')
    expect(yoloFlagFor('grok')).toBe('--always-approve')
    expect(yoloFlagFor('devin')).toBe('--permission-mode dangerous')
    expect(yoloFlagFor('pi')).toBeNull()
    expect(yoloFlagFor(null)).toBeNull()
    expect(yoloFlagFor(undefined)).toBeNull()
  })
})

describe('commandHasYoloFlag', () => {
  test('detects flags per agent', () => {
    expect(commandHasYoloFlag('claude --dangerously-skip-permissions', 'claude')).toBe(true)
    expect(commandHasYoloFlag('codex --yolo', 'codex')).toBe(true)
    expect(commandHasYoloFlag('grok --always-approve', 'grok')).toBe(true)
    expect(commandHasYoloFlag('devin --permission-mode dangerous', 'devin')).toBe(true)
  })

  test('detects aliases', () => {
    expect(commandHasYoloFlag('codex --dangerously-bypass-approvals-and-sandbox', 'codex')).toBe(true)
    expect(commandHasYoloFlag('grok --yolo', 'grok')).toBe(true)
    expect(commandHasYoloFlag('claude --permission-mode bypassPermissions', 'claude')).toBe(true)
    expect(commandHasYoloFlag('devin --permission-mode=dangerous', 'devin')).toBe(true)
  })

  test('does not match without an agent filter across all aliases', () => {
    expect(commandHasYoloFlag('claude --yolo')).toBe(true)
    expect(commandHasYoloFlag('vim foo.txt')).toBe(false)
  })

  test('does not match partial tokens', () => {
    expect(commandHasYoloFlag('claude --dangerously-skip-permissions-extra', 'claude')).toBe(false)
    expect(commandHasYoloFlag('codex', 'codex')).toBe(false)
  })
})

describe('addYoloFlag', () => {
  test('appends the flag', () => {
    expect(addYoloFlag('claude', 'claude')).toBe('claude --dangerously-skip-permissions')
    expect(addYoloFlag('codex', 'codex')).toBe('codex --yolo')
    expect(addYoloFlag(' devin ', 'devin')).toBe('devin --permission-mode dangerous')
  })

  test('is idempotent', () => {
    expect(addYoloFlag('claude --dangerously-skip-permissions', 'claude'))
      .toBe('claude --dangerously-skip-permissions')
    expect(addYoloFlag('codex --yolo', 'codex')).toBe('codex --yolo')
  })

  test('no-op for pi and empty commands', () => {
    expect(addYoloFlag('pi', 'pi')).toBe('pi')
    expect(addYoloFlag('', 'claude')).toBe('')
  })
})

describe('removeYoloFlag', () => {
  test('removes flags and collapses whitespace', () => {
    expect(removeYoloFlag('claude --dangerously-skip-permissions', 'claude')).toBe('claude')
    expect(removeYoloFlag('codex --yolo --search', 'codex')).toBe('codex --search')
    expect(removeYoloFlag('devin --permission-mode dangerous --verbose', 'devin'))
      .toBe('devin --verbose')
  })

  test('no-op for pi and unknown', () => {
    expect(removeYoloFlag('pi --fast', 'pi')).toBe('pi --fast')
  })
})

describe('yoloFlagForCommand', () => {
  test('detects agent from command string', () => {
    expect(yoloFlagForCommand('claude --model opus')).toBe('--dangerously-skip-permissions')
    expect(yoloFlagForCommand('codex')).toBe('--yolo')
    expect(yoloFlagForCommand('pi')).toBeNull()
    expect(yoloFlagForCommand('vim')).toBeNull()
  })
})
