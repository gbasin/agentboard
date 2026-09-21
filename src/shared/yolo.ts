// yolo.ts - "yolo mode" flags per agent harness.
// Maps each agent family to the CLI flag that skips permission prompts.

import type { AgentType } from './types'
import { agentFamily, inferAgentType, type AgentFamily } from './agentDetection'

/** Canonical flag appended when yolo mode is enabled. null = nothing to append. */
export const YOLO_FLAGS: Record<AgentFamily, string | null> = {
  claude: '--dangerously-skip-permissions',
  codex: '--yolo',
  grok: '--always-approve',
  devin: '--permission-mode dangerous',
  // Pi has no permission prompts by design — it is always effectively yolo.
  pi: null,
}

/** All flag spellings recognized when detecting whether a command is already yolo. */
const YOLO_FLAG_ALIASES: Record<AgentFamily, string[]> = {
  claude: ['--dangerously-skip-permissions', '--permission-mode bypassPermissions'],
  codex: ['--yolo', '--dangerously-bypass-approvals-and-sandbox'],
  grok: [
    '--always-approve',
    '--yolo',
    '--dangerously-skip-permissions',
    '--permission-mode bypassPermissions',
  ],
  devin: ['--permission-mode dangerous', '--permission-mode=dangerous'],
  pi: [],
}

export function yoloFlagFor(agentType: AgentType | null | undefined): string | null {
  const family = agentFamily(agentType)
  return family ? YOLO_FLAGS[family] : null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function aliasPattern(alias: string): RegExp {
  return new RegExp(`(^|\\s)${escapeRegExp(alias)}(?=\\s|$)`, 'g')
}

/** True when the command already carries a yolo flag for its agent (or any known one). */
export function commandHasYoloFlag(command: string, agentType?: AgentType | null): boolean {
  const families: AgentFamily[] = agentType
    ? [agentFamily(agentType)].filter((f): f is AgentFamily => f !== null)
    : (Object.keys(YOLO_FLAG_ALIASES) as AgentFamily[])
  return families.some((family) =>
    YOLO_FLAG_ALIASES[family].some((alias) => aliasPattern(alias).test(command))
  )
}

/** Append the yolo flag for the given agent if not already present. */
export function addYoloFlag(command: string, agentType: AgentType): string {
  const flag = yoloFlagFor(agentType)
  if (!flag) return command
  const trimmed = command.trim()
  if (!trimmed || commandHasYoloFlag(trimmed, agentType)) return trimmed
  return `${trimmed} ${flag}`
}

/** Remove any yolo flag aliases for the given agent from the command. */
export function removeYoloFlag(command: string, agentType: AgentType): string {
  const family = agentFamily(agentType)
  if (!family) return command
  let result = command
  for (const alias of YOLO_FLAG_ALIASES[family]) {
    result = result.replace(aliasPattern(alias), ' ')
  }
  return result.replace(/\s+/g, ' ').trim()
}

/** Detect the agent for a command and return its yolo flag, or null if unsupported. */
export function yoloFlagForCommand(command: string): string | null {
  const agentType = inferAgentType(command)
  return agentType ? yoloFlagFor(agentType) : null
}
