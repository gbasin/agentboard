import { describe, expect, it } from 'bun:test'
import { parseLogLine } from '../logParser'
import { escapeProjectPath } from '../logDiscovery'

describe('logParser', () => {
  it('detects assistant tool use', () => {
    const line = JSON.stringify({ type: 'assistant', stop_reason: 'tool_use' })
    expect(parseLogLine(line)).toEqual({ type: 'assistant_tool_use' })
  })

  it('detects turn end', () => {
    const line = JSON.stringify({ type: 'assistant', stop_reason: 'end_turn' })
    expect(parseLogLine(line)).toEqual({ type: 'turn_end' })
  })

  it('detects tool result', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result' }],
      },
    })
    expect(parseLogLine(line)).toEqual({ type: 'tool_result' })
  })

  it('detects user prompt', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { content: 'hello' },
    })
    expect(parseLogLine(line)).toEqual({ type: 'user_prompt' })
  })

  it('ignores bad lines', () => {
    expect(parseLogLine('not json')).toBeNull()
  })
})

describe('logDiscovery', () => {
  it('escapes project paths', () => {
    expect(escapeProjectPath('/Users/test/project')).toBe(
      '-Users-test-project'
    )
  })
})
