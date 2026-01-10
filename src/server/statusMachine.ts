import type { SessionStatus } from '../shared/types'

export type StatusEvent =
  | { type: 'log_found' }
  | { type: 'user_prompt' }
  | { type: 'assistant_tool_use' }
  | { type: 'tool_result' }
  | { type: 'turn_end' }
  | { type: 'idle_timeout' }
  | { type: 'tool_stall' }

export function transitionStatus(
  current: SessionStatus,
  event: StatusEvent
): SessionStatus {
  switch (event.type) {
    case 'log_found':
      return current === 'unknown' ? 'idle' : current
    case 'user_prompt':
      return 'working'
    case 'assistant_tool_use':
      // Stay working - StatusWatcher will transition to needs_approval
      // if tool_result doesn't arrive within the stall threshold
      return 'working'
    case 'tool_result':
      return 'working'
    case 'turn_end':
      return 'waiting'
    case 'idle_timeout':
      // Only transition to idle from 'waiting' - user hasn't responded
      // Don't transition from 'working' - Claude might still be thinking
      // (logs don't update during extended thinking periods)
      if (current === 'waiting') {
        return 'idle'
      }
      return current
    // Triggered by StatusWatcher when tool_use stalls
    case 'tool_stall':
      return 'needs_approval'
    default:
      return current
  }
}
