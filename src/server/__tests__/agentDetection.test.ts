import { describe, expect, test } from 'bun:test'
import { inferAgentType } from '../agentDetection'

describe('inferAgentType', () => {
  test('detects devin commands', () => {
    expect(inferAgentType('devin')).toBe('devin')
    expect(inferAgentType('devin --sandbox')).toBe('devin')
    expect(inferAgentType('/opt/homebrew/bin/devin')).toBe('devin')
    expect(inferAgentType('bash -lc devin')).toBe('devin')
    expect(inferAgentType('"devin -r abc123"')).toBe('devin')
    expect(inferAgentType('devin-cli')).toBe('devin')
  })

  test('detects other agents', () => {
    expect(inferAgentType('claude')).toBe('claude')
    expect(inferAgentType('npx codex')).toBe('codex')
    expect(inferAgentType('pi')).toBe('pi')
  })

  test('returns undefined for non-agent commands', () => {
    expect(inferAgentType('vim')).toBeUndefined()
    expect(inferAgentType('')).toBeUndefined()
    expect(inferAgentType('zsh')).toBeUndefined()
  })
})
