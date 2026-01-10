import { describe, expect, it } from 'bun:test'
import { transitionStatus, type StatusEvent } from '../statusMachine'

describe('statusMachine', () => {
  it('moves from unknown to idle on log_found', () => {
    expect(transitionStatus('unknown', { type: 'log_found' })).toBe('idle')
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
    expect(transitionStatus('idle', { type: 'user_prompt' })).toBe('working')
  })

  it('marks tool results as working', () => {
    expect(transitionStatus('waiting', { type: 'tool_result' })).toBe('working')
  })

  it('falls back to current state for unknown events', () => {
    const event = { type: 'unknown' } as unknown as StatusEvent
    expect(transitionStatus('idle', event)).toBe('idle')
  })

  it('keeps needs_approval during idle timeout', () => {
    expect(transitionStatus('needs_approval', { type: 'idle_timeout' })).toBe(
      'needs_approval'
    )
  })

  it('keeps working during idle timeout (Claude may still be thinking)', () => {
    expect(transitionStatus('working', { type: 'idle_timeout' })).toBe('working')
  })

  it('transitions waiting to idle on timeout', () => {
    expect(transitionStatus('waiting', { type: 'idle_timeout' })).toBe('idle')
  })

  it('turn_end moves to waiting', () => {
    expect(transitionStatus('working', { type: 'turn_end' })).toBe('waiting')
  })
})
