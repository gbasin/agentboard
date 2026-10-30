// Passive transcript observations. "tool" means pending, not proven execution.
export interface AgentActivity {
  phase: 'model' | 'tool' | 'blocked' | 'idle' | 'unknown'
  label: string
  updatedAt?: string
  tools: string[]
}

export interface SubagentActivity {
  id: string
  name: string
  activity: AgentActivity
}

export interface SessionActivity {
  main: AgentActivity
  subagents: SubagentActivity[]
  running: number
  unknown: number
  blocked: number
  total: number
  /** Some children were omitted from details to bound the WebSocket payload. */
  truncated: boolean
}
