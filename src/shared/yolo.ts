// yolo.ts - "yolo mode" flags per agent harness.
// Maps each agent family to the CLI flag that skips permission prompts.

import type { AgentType } from './types'
import {
  agentFamily,
  findAgentToken,
  inferAgentType,
  normalizePaneStartCommand,
  type AgentFamily,
} from './agentDetection'

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
  claude: [
    '--dangerously-skip-permissions',
    '--permission-mode bypassPermissions',
    '--permission-mode=bypassPermissions',
  ],
  codex: ['--yolo', '--dangerously-bypass-approvals-and-sandbox'],
  grok: [
    '--always-approve',
    '--yolo',
    '--dangerously-skip-permissions',
    '--permission-mode bypassPermissions',
    '--permission-mode=bypassPermissions',
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

function insertAfterAgentToken(command: string, flag: string): string | null {
  const token = findAgentToken(command)
  if (!token) return null
  return `${command.slice(0, token.end)} ${flag}${command.slice(token.end)}`
}

/**
 * Insert the yolo flag right after the agent executable token so it plays
 * nicely with other args: `claude --model x` -> `claude <flag> --model x`,
 * `devin -- prompt` -> `devin <flag> -- prompt`, `claude && make` ->
 * `claude <flag> && make`.
 */
export function addYoloFlag(command: string, agentType: AgentType): string {
  const flag = yoloFlagFor(agentType)
  if (!flag) return command
  const trimmed = command.trim()
  if (!trimmed || commandHasYoloFlag(trimmed, agentType)) return trimmed

  const direct = insertAfterAgentToken(trimmed, flag)
  if (direct) return direct

  // Wrapped/quoted form (e.g. bash -lc 'claude --model x'): rebuild the inner
  // command with the flag and re-wrap it in a bash login call.
  const inner = normalizePaneStartCommand(trimmed)
  if (inner && inner !== trimmed) {
    const inserted = insertAfterAgentToken(inner, flag)
    if (inserted) {
      return `bash -lc '${inserted.replace(/'/g, `'\\''`)}'`
    }
  }

  return `${trimmed} ${flag}`
}

/**
 * Reason the yolo flag can't be added to this command, or null when safe.
 * Codex's --yolo conflicts with -a/--ask-for-approval and --full-auto;
 * a pre-existing --permission-mode with a different value conflicts for
 * claude/grok/devin.
 */
export function yoloConflict(command: string, agentType: AgentType): string | null {
  const family = agentFamily(agentType)
  if (!family || commandHasYoloFlag(command, agentType)) return null

  if (family === 'codex') {
    const m = /(^|\s)(--full-auto|--ask-for-approval|-a)(?=\s|=|$)/.exec(command)
    if (m) return `conflicts with ${m[2]}`
  }

  const pm = /(^|\s)--permission-mode(?:\s+|=)(\S+)/.exec(command)
  if (pm && family !== 'codex') {
    return `conflicts with --permission-mode ${pm[2]}`
  }

  return null
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
