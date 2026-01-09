import type { StatusEvent } from './statusMachine'

interface LogEntry {
  type?: string
  stop_reason?: string
  message?: {
    role?: string
    content?: string | Array<{ type?: string }>
  }
}

export function parseLogLine(line: string): StatusEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }

  let entry: LogEntry
  try {
    entry = JSON.parse(trimmed) as LogEntry
  } catch {
    return null
  }

  if (entry.type === 'assistant') {
    if (entry.stop_reason === 'tool_use') {
      return { type: 'assistant_tool_use' }
    }
    if (entry.stop_reason === 'end_turn') {
      return { type: 'turn_end' }
    }
  }

  if (entry.type === 'user') {
    const content = entry.message?.content
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block) => block && block.type === 'tool_result'
      )
      if (hasToolResult) {
        return { type: 'tool_result' }
      }
    }

    return { type: 'user_prompt' }
  }

  return null
}
