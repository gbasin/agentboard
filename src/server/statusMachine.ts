import type { SessionStatus } from '../shared/types'

export type StatusEvent =
  | { type: 'log_found' }
  | { type: 'user_prompt' }
  | { type: 'assistant_tool_use' }
  | { type: 'tool_result' }
  | { type: 'turn_end' }
  | { type: 'idle_timeout' }

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
      return 'needs_approval'
    case 'tool_result':
      return 'working'
    case 'turn_end':
      return 'waiting'
    case 'idle_timeout':
      return current === 'needs_approval' ? current : 'idle'
    default:
      return current
  }
}
