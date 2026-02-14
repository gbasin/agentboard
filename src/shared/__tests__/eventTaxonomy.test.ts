import { describe, expect, test } from 'bun:test'
import {
  normalizeAgentLogEntry,
  parseAndNormalizeAgentLogLine,
} from '../eventTaxonomy'

describe('eventTaxonomy', () => {
  test('normalizes Codex response_item message content', () => {
    const events = normalizeAgentLogEntry({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'help me debug this' },
          { type: 'tool_result', content: 'ignored tool output' },
        ],
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({
      kind: 'message',
      role: 'user',
      text: 'help me debug this',
      source: {
        family: 'codex',
        rawType: 'response_item',
        payloadType: 'message',
      },
    })
  })

  test('normalizes Codex event_msg user_message events', () => {
    const parsed = parseAndNormalizeAgentLogLine(
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'user_message', message: 'can you fix the bug' },
      })
    )

    expect(parsed?.parsed).toBe(true)
    expect(parsed?.events).toEqual([
      {
        kind: 'message',
        role: 'user',
        text: 'can you fix the bug',
        source: {
          family: 'codex',
          rawType: 'event_msg',
          payloadType: 'user_message',
        },
      },
    ])
  })

  test('normalizes mixed event_msg message payload variants', () => {
    const userObjectMessage = normalizeAgentLogEntry({
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: {
          role: 'user',
          content: [{ type: 'input_text', text: 'from structured user message' }],
        },
      },
    })
    const assistantMessage = normalizeAgentLogEntry({
      type: 'event_msg',
      payload: {
        type: 'assistant_message',
        message: 'assistant payload message',
      },
    })

    expect(userObjectMessage).toHaveLength(1)
    expect(userObjectMessage[0]?.role).toBe('user')
    expect(userObjectMessage[0]?.text).toBe('from structured user message')
    expect(userObjectMessage[0]?.source.family).toBe('codex')

    expect(assistantMessage).toHaveLength(1)
    expect(assistantMessage[0]?.role).toBe('assistant')
    expect(assistantMessage[0]?.text).toBe('assistant payload message')
    expect(assistantMessage[0]?.source.payloadType).toBe('assistant_message')
  })

  test('normalizes user and assistant message variants', () => {
    const userEvents = normalizeAgentLogEntry({
      type: 'user',
      content: [{ type: 'text', text: 'hello world' }],
    })
    const assistantEvents = normalizeAgentLogEntry({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello back' }],
      },
    })

    expect(userEvents[0]?.role).toBe('user')
    expect(userEvents[0]?.text).toBe('hello world')
    expect(assistantEvents[0]?.role).toBe('assistant')
    expect(assistantEvents[0]?.text).toBe('hello back')
  })

  test('keeps payload message/content fallback coverage for unknown event payload types', () => {
    const events = normalizeAgentLogEntry({
      type: 'event_msg',
      payload: {
        type: 'custom_preview_payload',
        message: 'payload fallback message',
      },
    })
    expect(events).toEqual([
      {
        kind: 'unknown',
        role: 'other',
        text: 'payload fallback message',
        source: {
          family: 'codex',
          rawType: 'event_msg',
          payloadType: 'custom_preview_payload',
        },
      },
    ])
  })

  test('prefers explicit pi metadata when type overlaps with other schemas', () => {
    const events = normalizeAgentLogEntry({
      type: 'user',
      source: 'pi',
      message: { role: 'user', content: 'hello from pi' },
    })

    expect(events[0]?.source.family).toBe('pi')
  })

  test('normalizes tool events and tool-result markers', () => {
    const toolCall = normalizeAgentLogEntry({
      type: 'tool_use',
      name: 'search',
    })
    const toolResult = normalizeAgentLogEntry({
      type: 'event',
      payload: { type: 'custom_tool_call_output', output: 'done' },
    })

    expect(toolCall).toEqual([
      {
        kind: 'tool_call',
        role: 'assistant',
        text: '[Tool: search]',
        source: {
          family: 'claude',
          rawType: 'tool_use',
        },
      },
    ])
    expect(toolResult).toEqual([
      {
        kind: 'tool_result',
        role: 'tool',
        text: '',
        source: {
          family: 'unknown',
          rawType: 'event',
          payloadType: 'custom_tool_call_output',
        },
      },
    ])
  })

  test('returns malformed JSON fallback without throwing', () => {
    const parsed = parseAndNormalizeAgentLogLine('this is not valid json')
    expect(parsed?.parsed).toBe(false)
    expect(parsed?.events[0]?.kind).toBe('unknown')
    expect(parsed?.events[0]?.text).toBe('this is not valid json')
  })

  test('falls back to unknown event content for unmapped JSON entries', () => {
    const events = normalizeAgentLogEntry({
      type: 'something_new',
      message: 'forward-compatible payload',
    })
    expect(events).toEqual([
      {
        kind: 'unknown',
        role: 'other',
        text: 'forward-compatible payload',
        source: {
          family: 'unknown',
          rawType: 'something_new',
        },
      },
    ])
  })
})
