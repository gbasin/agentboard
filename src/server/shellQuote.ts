// Shell-quoting utility for safe passage through remote bash shells.

/**
 * Shell-quote a string for safe passage through a remote bash shell.
 * Simple args (alphanumeric + common safe chars) pass through unquoted.
 * Everything else gets single-quoted with internal quotes escaped.
 */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-/:@+=]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
