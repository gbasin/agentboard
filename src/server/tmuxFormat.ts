// Keep parsed tmux formats on tabs. `tmux -u` preserves tabs under minimal
// locales, while the raw unit-separator transport regressed real Linux tmux
// discovery in CI.
const TMUX_FIELD_SEPARATOR = '\t'
const TMUX_UTF8_FLAG = '-u'

// Placeholder window kept alive in the base session so the session itself
// persists even when the user has no real windows. Tmux requires every
// session to contain at least one window, so we run a long-lived no-op here.
// Listings filter out windows whose name matches BOOTSTRAP_WINDOW_NAME.
const BOOTSTRAP_WINDOW_NAME = '__agentboard_root__'
const BOOTSTRAP_WINDOW_COMMAND = 'tail -f /dev/null'

function withTmuxUtf8Flag(args: string[]): string[] {
  if (args[0] === TMUX_UTF8_FLAG) {
    return args
  }
  return [TMUX_UTF8_FLAG, ...args]
}

function buildTmuxFormat(fields: string[]): string {
  return fields.join(TMUX_FIELD_SEPARATOR)
}

function splitTmuxFields(
  line: string,
  expectedFieldCount: number
): string[] | null {
  const parts = line.split(TMUX_FIELD_SEPARATOR)
  return parts.length === expectedFieldCount ? parts : null
}

function splitTmuxLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
}

export {
  BOOTSTRAP_WINDOW_COMMAND,
  BOOTSTRAP_WINDOW_NAME,
  TMUX_FIELD_SEPARATOR,
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
}
