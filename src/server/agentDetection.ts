// agentDetection.ts - Shared agent type detection logic
// Used by both SessionManager and sessionRefreshWorker

import type { AgentType } from '../shared/types'

function unquoteShellString(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if (first === "'" && last === "'") {
      // Undo our shellQuote escaping: 'foo'\''bar' -> foo'bar
      return trimmed.slice(1, -1).replace(/'\\''/g, "'")
    }
    if (first === '"' && last === '"') {
      // Best-effort: handle basic escapes.
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return trimmed
}

function unwrapBashLoginWrapper(command: string): string | null {
  // Expect: bash -lc/-lic <cmd>. Some tmux formatters lose quoting, so treat
  // the "cmd" as the rest of the string after the flags token.
  const trimmed = command.trim()
  const firstSpace = trimmed.search(/\s/)
  if (firstSpace === -1) return null

  const bashToken = trimmed.slice(0, firstSpace)
  const bashBase = bashToken.split('/').pop()
  if (bashBase !== 'bash') return null

  let idx = firstSpace
  while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++

  let sawLogin = false
  let sawCommand = false

  while (idx < trimmed.length) {
    const tokenStart = idx
    while (idx < trimmed.length && !/\s/.test(trimmed[idx]!)) idx++
    const tok = trimmed.slice(tokenStart, idx)
    while (idx < trimmed.length && /\s/.test(trimmed[idx]!)) idx++

    if (!tok.startsWith('-') || tok === '-') {
      return null
    }
    if (tok === '--') {
      break
    }
    if (tok.startsWith('--')) {
      // Ignore long options; we only care about short option bundles like -lc/-lic.
      continue
    }
    if (!/^-[a-zA-Z]+$/.test(tok)) {
      continue
    }

    const letters = tok.slice(1)
    if (letters.includes('l')) sawLogin = true
    if (letters.includes('c')) {
      sawCommand = true
      break
    }
  }

  if (!sawLogin || !sawCommand) return null

  const rest = trimmed.slice(idx).trim()
  if (!rest) return null
  return unquoteShellString(rest)
}

export function normalizePaneStartCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''
  // tmux #{pane_start_command} may wrap the entire command in quotes
  const unquoted = unquoteShellString(trimmed)
  const unwrapped = unwrapBashLoginWrapper(unquoted)
  return unwrapped ?? unquoted
}

/**
 * Infer agent type from the pane start command.
 * Handles various invocation patterns:
 * - Full paths: /usr/local/bin/claude -> claude
 * - Package runners: npx codex, bunx claude -> codex, claude
 * - Flags: claude --help, codex --search -> claude, codex
 * - Quoted commands: "codex --search" -> codex
 */
export function inferAgentType(command: string): AgentType | undefined {
  const normalizedInput = normalizePaneStartCommand(command)
  if (!normalizedInput) {
    return undefined
  }

  const normalized = normalizedInput.toLowerCase().trim().replace(/^["']|["']$/g, '')
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
