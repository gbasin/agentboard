// Keep parsed tmux formats on tabs. `tmux -u` preserves tabs under minimal
// locales, while the raw unit-separator transport regressed real Linux tmux
// discovery in CI.
const TMUX_FIELD_SEPARATOR = '\t'
const TMUX_UTF8_FLAG = '-u'

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
  TMUX_FIELD_SEPARATOR,
  buildTmuxFormat,
  splitTmuxFields,
  splitTmuxLines,
  withTmuxUtf8Flag,
}
