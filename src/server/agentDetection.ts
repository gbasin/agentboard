// agentDetection.ts - Shared agent type detection logic
// Used by both SessionManager and sessionRefreshWorker

import type { AgentType } from '../shared/types'

/**
 * Infer agent type from the pane start command.
 * Handles various invocation patterns:
 * - Full paths: /usr/local/bin/claude -> claude
 * - Package runners: npx codex, bunx claude -> codex, claude
 * - Flags: claude --help, codex --search -> claude, codex
 * - Quoted commands: "codex --search" -> codex
 */
export function inferAgentType(command: string): AgentType | undefined {
  if (!command) {
    return undefined
  }

  const normalized = command.toLowerCase().trim().replace(/^["']|["']$/g, '')
  const parts = normalized.split(/\s+/)

  for (const part of parts) {
    // Skip common package runners/prefixes
    if (['npx', 'bunx', 'pnpm', 'yarn', 'env'].includes(part)) {
      continue
    }
    // Skip environment variable assignments (KEY=value)
    if (part.includes('=')) {
      continue
    }
    // Skip flags
    if (part.startsWith('-')) {
      continue
    }

    // Extract base name from path
    const baseName = part.split('/').pop() || part

    if (baseName === 'claude') {
      return 'claude'
    }
    if (baseName === 'codex') {
      return 'codex'
    }
    if (baseName === 'pi') {
      return 'pi'
    }

    // Found a non-skippable command that isn't a known agent
    break
  }

  return undefined
}
