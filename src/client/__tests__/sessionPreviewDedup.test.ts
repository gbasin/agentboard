import { describe, expect, test } from 'bun:test'
import {
  dedupeAdjacentMessageEntries,
  annotateGroupedEntries,
  type ParsedEntry,
} from '../components/SessionPreviewContent'

function entry(overrides: Partial<ParsedEntry> & Pick<ParsedEntry, 'type' | 'kind' | 'content'>): ParsedEntry {
  return {
    raw: '',
    sourceKey: `${overrides.lineNumber ?? 0}`,
    lineNumber: overrides.lineNumber ?? 0,
    seq: 0,
    exactLineNumber: true,
    ...overrides,
  }
}

describe('dedupeAdjacentMessageEntries', () => {
  test('collapses the Codex agent_message + response_item assistant pair', () => {
    // Codex logs each assistant turn twice, adjacently: once as an event_msg
    // (agent_message) and once as a response_item message, with identical text.
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'I will check the code', lineNumber: 9 }),
      entry({ type: 'assistant', kind: 'message', content: 'I will check the code', lineNumber: 10 }),
    ]
    const result = dedupeAdjacentMessageEntries(input)
    expect(result).toHaveLength(1)
    expect(result[0]?.lineNumber).toBe(9)
  })

  test('collapses the duplicated user turn (response_item + event_msg)', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: "let's try it", lineNumber: 6 }),
      entry({ type: 'user', kind: 'message', content: "let's try it", lineNumber: 7 }),
    ]
    expect(dedupeAdjacentMessageEntries(input)).toHaveLength(1)
  })

  test('keeps messages with the same text but different roles', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'ok', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'ok', lineNumber: 2 }),
    ]
    expect(dedupeAdjacentMessageEntries(input)).toHaveLength(2)
  })

  test('keeps identical messages that are not adjacent (separated by a tool call)', () => {
    // Two distinct assistant turns can legitimately repeat text; a tool entry
    // between them means they are not the same logged turn.
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'Done', lineNumber: 1 }),
      entry({ type: 'tool', kind: 'tool_call', content: '[Tool: bash]', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'Done', lineNumber: 3 }),
    ]
    expect(dedupeAdjacentMessageEntries(input)).toHaveLength(3)
  })

  test('does not collapse adjacent identical tool calls', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'tool', kind: 'tool_call', content: '[Tool: read]', lineNumber: 1 }),
      entry({ type: 'tool', kind: 'tool_call', content: '[Tool: read]', lineNumber: 2 }),
    ]
    expect(dedupeAdjacentMessageEntries(input)).toHaveLength(2)
  })

  test('preserves a normal alternating conversation unchanged', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'hi', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'hello', lineNumber: 2 }),
      entry({ type: 'user', kind: 'message', content: 'bye', lineNumber: 3 }),
    ]
    expect(dedupeAdjacentMessageEntries(input)).toEqual(input)
  })
})

describe('annotateGroupedEntries', () => {
  test('shows the role label only at the start of a same-role run', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'step 1', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'step 2', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'step 3', lineNumber: 3 }),
    ]
    expect(annotateGroupedEntries(input).map((e) => e.showRole)).toEqual([true, false, false])
  })

  test('starts a new group when the role changes', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'do it', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'on it', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'more', lineNumber: 3 }),
      entry({ type: 'user', kind: 'message', content: 'thanks', lineNumber: 4 }),
    ]
    expect(annotateGroupedEntries(input).map((e) => e.showRole)).toEqual([true, true, false, true])
  })

  test('a tool call between assistant messages does not break the run', () => {
    // The assistant message after the tool call stays grouped (showRole false).
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'running a tool', lineNumber: 1 }),
      entry({ type: 'tool', kind: 'tool_call', content: '[Tool: bash]', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'tool done', lineNumber: 3 }),
    ]
    const result = annotateGroupedEntries(input)
    expect(result.map((e) => e.showRole)).toEqual([true, false, false])
  })

  test('does not mutate or drop entries', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'hi', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'hello', lineNumber: 2 }),
    ]
    const result = annotateGroupedEntries(input)
    expect(result).toHaveLength(2)
    expect(result.map((e) => e.entry)).toEqual(input)
  })
})
