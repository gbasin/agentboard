import { describe, expect, it } from 'bun:test'
import { transitionStatus, type StatusEvent } from '../statusMachine'

describe('statusMachine', () => {
  it('moves from unknown to waiting on log_found', () => {
    expect(transitionStatus('unknown', { type: 'log_found' })).toBe('waiting')
  })

  it('keeps working on tool use (stall detection handles approval)', () => {
    expect(transitionStatus('working', { type: 'assistant_tool_use' })).toBe(
      'working'
    )
  })

  it('marks tool_stall as needs_approval', () => {
    expect(transitionStatus('working', { type: 'tool_stall' })).toBe(
      'needs_approval'
    )
  })

  it('marks user prompts as working', () => {
    expect(transitionStatus('waiting', { type: 'user_prompt' })).toBe('working')
  })

  it('marks tool results as working', () => {
    expect(transitionStatus('waiting', { type: 'tool_result' })).toBe('working')
  })

  it('falls back to current state for unknown events', () => {
    const event = { type: 'unknown' } as unknown as StatusEvent
    expect(transitionStatus('waiting', event)).toBe('waiting')
  })

  it('turn_end moves to waiting', () => {
    expect(transitionStatus('working', { type: 'turn_end' })).toBe('waiting')
  })
})
