// Validation for user-supplied session (tmux window) names, shared by the
// create and rename paths.
//
// Window names ride through `list-windows -F` output, which is tab/newline
// separated, so control characters would corrupt parsing (tmux itself also
// rejects them). '\' is rejected because tmux format output escapes it as
// '\\', so names could not round-trip. Everything else — spaces, punctuation,
// unicode — is legal; windows are always addressed by @id, never by name, so
// target-grammar characters like ':' and '.' are safe too.

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/

export const MAX_WINDOW_NAME_LENGTH = 120

/**
 * Returns an error message when `name` cannot be used as a window name,
 * or `null` when it is valid. Accepts the raw input; trims internally.
 */
export function windowNameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'Name cannot be empty'
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return 'Name cannot contain control characters'
  }
  if (trimmed.includes('\\')) {
    return 'Name cannot contain backslashes'
  }
  if (trimmed.length > MAX_WINDOW_NAME_LENGTH) {
    return `Name cannot exceed ${MAX_WINDOW_NAME_LENGTH} characters`
  }
  return null
}
