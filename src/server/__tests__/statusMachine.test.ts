import { describe, expect, it } from 'bun:test'
import { transitionStatus } from '../statusMachine'

describe('statusMachine', () => {
  it('moves from unknown to idle on log_found', () => {
    expect(transitionStatus('unknown', { type: 'log_found' })).toBe('idle')
  })

  it('marks tool use as needs_approval', () => {
    expect(transitionStatus('working', { type: 'assistant_tool_use' })).toBe(
      'needs_approval'
    )
  })

  it('keeps needs_approval during idle timeout', () => {
    expect(transitionStatus('needs_approval', { type: 'idle_timeout' })).toBe(
      'needs_approval'
    )
  })

  it('turn_end moves to waiting', () => {
    expect(transitionStatus('working', { type: 'turn_end' })).toBe('waiting')
  })
})
