import { describe, expect, test } from 'bun:test'
import { agentFamily, inferAgentType } from '../agentDetection'

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
    expect(inferAgentType('/usr/local/bin/claude --model opus')).toBe('claude')
    expect(inferAgentType('npx codex')).toBe('codex')
    expect(inferAgentType('codex --search')).toBe('codex')
    expect(inferAgentType('pi')).toBe('pi')
  })

  test('detects omp binary and package invocations', () => {
    expect(inferAgentType('omp')).toBe('omp')
    expect(inferAgentType('omp --model opus')).toBe('omp')
    expect(inferAgentType('/Users/x/.bun/bin/omp')).toBe('omp')
    expect(inferAgentType('bunx @oh-my-pi/pi-coding-agent')).toBe('omp')
    expect(inferAgentType('npx @oh-my-pi/pi-coding-agent --print "hi"')).toBe('omp')
  })

  test('does not confuse upstream pi package for omp', () => {
    // Unscoped/bare pi-coding-agent is ambiguous; only @oh-my-pi scope maps to omp
    expect(inferAgentType('npx pi-coding-agent')).toBeUndefined()
    expect(inferAgentType('pi --resume abc')).toBe('pi')
  })

  test('unwraps bash -lc wrappers and quoted commands', () => {
    expect(inferAgentType(`bash -lc 'omp --model gemini'`)).toBe('omp')
    expect(inferAgentType('"omp"')).toBe('omp')
  })

  test('returns undefined for non-agent commands', () => {
    expect(inferAgentType('vim')).toBeUndefined()
    expect(inferAgentType('')).toBeUndefined()
    expect(inferAgentType('zsh')).toBeUndefined()
    expect(inferAgentType('vim file.txt')).toBeUndefined()
  })
})

describe('agentFamily', () => {
  test('collapses claude variants, keeps omp distinct from pi', () => {
    expect(agentFamily('claude-rp')).toBe('claude')
    expect(agentFamily('pi')).toBe('pi')
    expect(agentFamily('omp')).toBe('omp')
    expect(agentFamily(null)).toBeNull()
    expect(agentFamily(undefined)).toBeNull()
  })
})
