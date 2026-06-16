import { describe, expect, test } from 'bun:test'
import {
  dedupeAdjacentMessageEntries,
  groupEntriesForDisplay,
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

describe('groupEntriesForDisplay', () => {
  test('shows the role label only at the start of a same-role run', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'step 1', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'step 2', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'step 3', lineNumber: 3 }),
    ]
    // One run -> label on the first (oldest) entry, kept in chronological order.
    const result = groupEntriesForDisplay(input)
    expect(result.map((e) => e.entry.content)).toEqual(['step 1', 'step 2', 'step 3'])
    expect(result.map((e) => e.showRole)).toEqual([true, false, false])
  })

  test('emits runs newest-first but keeps each run chronological', () => {
    // Two turns oldest-first: turn A (user + 2 assistant steps), then turn B.
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'A: do it', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'A: step 1', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'A: step 2', lineNumber: 3 }),
      entry({ type: 'user', kind: 'message', content: 'B: do it', lineNumber: 4 }),
      entry({ type: 'assistant', kind: 'message', content: 'B: step 1', lineNumber: 5 }),
    ]
    const result = groupEntriesForDisplay(input)
    // Newest run (B assistant) first; within each run chronological order.
    expect(result.map((e) => e.entry.content)).toEqual([
      'B: step 1',
      'B: do it',
      'A: step 1',
      'A: step 2',
      'A: do it',
    ])
    expect(result.map((e) => e.showRole)).toEqual([true, true, true, false, true])
  })

  test('a tool call between assistant messages does not break the run', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'assistant', kind: 'message', content: 'running a tool', lineNumber: 1 }),
      entry({ type: 'tool', kind: 'tool_call', content: '[Tool: bash]', lineNumber: 2 }),
      entry({ type: 'assistant', kind: 'message', content: 'tool done', lineNumber: 3 }),
    ]
    const result = groupEntriesForDisplay(input)
    // Single run, chronological: label on first message, tool unlabeled, second
    // assistant stays grouped.
    expect(result.map((e) => e.entry.content)).toEqual(['running a tool', '[Tool: bash]', 'tool done'])
    expect(result.map((e) => e.showRole)).toEqual([true, false, false])
  })

  test('does not mutate or drop entries', () => {
    const input: ParsedEntry[] = [
      entry({ type: 'user', kind: 'message', content: 'hi', lineNumber: 1 }),
      entry({ type: 'assistant', kind: 'message', content: 'hello', lineNumber: 2 }),
    ]
    const result = groupEntriesForDisplay(input)
    expect(result).toHaveLength(2)
    // Two single-entry runs, reversed: assistant turn first.
    expect(result.map((e) => e.entry.content)).toEqual(['hello', 'hi'])
  })
})
