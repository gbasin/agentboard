// validators.ts - Input validation utilities for session and tmux operations

export const MAX_FIELD_LENGTH = 4096
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:@-]+$/
export const TMUX_TARGET_PATTERN =
  /^(?:[A-Za-z0-9_.-]+:)?(?:@[0-9]+|[A-Za-z0-9_.-]+)$/

export function isValidSessionId(sessionId: string): boolean {
  if (!sessionId || sessionId.length > MAX_FIELD_LENGTH) {
    return false
  }
  return SESSION_ID_PATTERN.test(sessionId)
}

export function isValidTmuxTarget(target: string): boolean {
  if (!target || target.length > MAX_FIELD_LENGTH) {
    return false
  }
  return TMUX_TARGET_PATTERN.test(target)
}

// Shell metacharacters that enable injection (chaining, piping, subshells, expansion)
const SHELL_METACHAR_PATTERN = /[;|&$`(){}<>\n\r\\]/

/**
 * Validate a command for session-create.
 *
 * Layer 1: Reject shell metacharacters to prevent injection.
 * Layer 2: If allowedCommands is non-empty, only listed binaries can be
 *          the first token (basename) of the command.
 *
 * Empty/undefined command returns true (SessionManager defaults to `claude`).
 */
export function isValidSessionCommand(
  command: string | undefined,
  allowedCommands?: string[]
): { valid: boolean; reason?: string } {
  // Empty command is fine — SessionManager defaults to `claude`
  if (!command) {
    return { valid: true }
  }

  if (command.length > MAX_FIELD_LENGTH) {
    return { valid: false, reason: 'Command too long' }
  }

  // Layer 1: metacharacter blocking
  if (SHELL_METACHAR_PATTERN.test(command)) {
    return { valid: false, reason: 'Command contains invalid characters' }
  }

  // Layer 2: optional allowlist
  if (allowedCommands && allowedCommands.length > 0) {
    const firstToken = command.trim().split(/\s+/)[0]
    if (!firstToken) {
      return { valid: true } // whitespace-only treated as empty
    }
    // Extract basename (e.g. "/usr/bin/claude" -> "claude")
    const binary = firstToken.split('/').pop() || firstToken
    if (!allowedCommands.includes(binary)) {
      return {
        valid: false,
        reason: `Command not in allowed list: ${binary}. Allowed: ${allowedCommands.join(', ')}`,
      }
    }
  }

  return { valid: true }
}
