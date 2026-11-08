// Reduces lifecycle and tool envelopes only; never sends prompts, arguments,
// reasoning, or tool output to the client. Missing evidence stays unknown.
import type { AgentActivity } from '../shared/activity'

export interface ActivityState {
  phase: AgentActivity['phase']
  updatedAt?: string
  name?: string
  turnId?: string
  tools: Map<string, string>
}

export function newActivityState(): ActivityState {
  return { phase: 'unknown', tools: new Map() }
}

type RecordValue = Record<string, unknown>
function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' ? value as RecordValue : {}
}

function tool(state: ActivityState, id: unknown, name: unknown): void {
  if (typeof id !== 'string' || typeof name !== 'string') return
  // A corrupt transcript must not grow an unbounded pending-call map.
  if (state.tools.size >= 128) state.tools.delete(state.tools.keys().next().value!)
  state.tools.set(id, name.slice(0, 80))
  state.phase = 'tool'
}

export function reduceActivity(state: ActivityState, value: unknown, kind: 'claude' | 'codex'): void {
  const e = record(value)
  const p = record(e.payload)
  const m = record(e.message)
  let relevant = false
  if (kind === 'codex') {
    if (e.type === 'session_meta') {
      // Forked history may precede the child's own metadata.
      const spawn = record(record(record(p.source).subagent).thread_spawn)
      const name = spawn.agent_path ?? spawn.agent_nickname ?? p.agent_nickname
      state.name = typeof name === 'string' ? name.slice(0, 120) : undefined
      state.updatedAt = undefined
      state.phase = 'unknown'
      state.tools.clear()
      state.turnId = undefined
    }
    if (e.type === 'event_msg') {
      if (p.type === 'task_started') {
        state.phase = 'model'
        state.turnId = typeof p.turn_id === 'string' ? p.turn_id : undefined
        state.tools.clear()
        relevant = true
      } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
        if (!state.turnId || !p.turn_id || p.turn_id === state.turnId) {
          state.phase = 'idle'
          state.tools.clear()
          relevant = true
        }
      }
    }
    if (e.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        tool(state, p.call_id, p.name)
        relevant = true
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        if (typeof p.call_id === 'string' && state.tools.delete(p.call_id)) {
          state.phase = state.tools.size ? 'tool' : 'model'
          relevant = true
        }
      }
    }
  } else {
    if (e.type === 'api-request') {
      state.phase = state.tools.size ? 'tool' : 'model'
      relevant = true
    }
    if (e.type === 'user' && e.isMeta !== true && (
      typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some(c => record(c).type === 'text'))
    )) {
      state.phase = 'model'
      state.tools.clear()
      relevant = true
    }
    if (e.type === 'assistant' || e.type === 'user') {
      const content = Array.isArray(m.content) ? m.content : []
      for (const item of content) {
        const c = record(item)
        if (c.type === 'tool_use') {
          tool(state, c.id, c.name)
          relevant = true
        } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
          if (state.tools.delete(c.tool_use_id)) {
            state.phase = state.tools.size ? 'tool' : 'model'
            relevant = true
          }
        }
      }
      if (e.type === 'assistant' && (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence')) {
        state.phase = 'idle'
        state.tools.clear()
        relevant = true
      }
    }
    if (e.type === 'system' && e.subtype === 'turn_duration') {
      state.phase = 'idle'
      state.tools.clear()
      relevant = true
    }
  }
  if (relevant && typeof e.timestamp === 'string') state.updatedAt = e.timestamp
}

export function activitySnapshot(state: ActivityState): AgentActivity {
  const tools = [...new Set(state.tools.values())].sort()
  const label = state.phase === 'tool'
    ? tools.some(t => /^(AskUserQuestion|request_user_input|request_user_input_async)$/.test(t))
      ? 'Waiting for input'
      : tools.some(t => /^(wait_agent|wait)$/.test(t)) ? 'Waiting on tool or agents'
      : `Tool pending: ${tools.slice(0, 3).join(', ')}${tools.length > 3 ? ` +${tools.length - 3} more` : ''}`
    : state.phase === 'model' ? 'Model turn active'
    : state.phase === 'idle' ? 'Turn finished' : 'Activity unknown'
  const phase = state.phase === 'tool' && tools.length === 1 && /^(AskUserQuestion|request_user_input|request_user_input_async)$/.test(tools[0]) ? 'blocked' : state.phase
  return { phase, label, updatedAt: state.updatedAt, tools: tools.slice(0, 8) }
}
