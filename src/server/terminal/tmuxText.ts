const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex -- need to match ANSI escapes
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

export const TMUX_DECORATIVE_LINE_PATTERN =
  /^[\s─━│┃┄┅┆┇┈┉┊┋┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬═╭╮╯╰▔▁]+$/

const TMUX_METADATA_BASE_PATTERNS: ReadonlyArray<RegExp> = [
  /context left/i,
  /background terminal running/i,
  /for shortcuts/i,
]

export const TMUX_METADATA_MATCH_PATTERNS: ReadonlyArray<RegExp> = [
  ...TMUX_METADATA_BASE_PATTERNS,
  /todos?\b/i,
  /accept edits/i,
  /baked for/i,
  /opus .* on /i,
  /^\s*[☐☑■□]/,
]

export const TMUX_METADATA_STATUS_PATTERNS: ReadonlyArray<RegExp> = [
  ...TMUX_METADATA_BASE_PATTERNS,
  /\/ps to view/i,
  /esc to interrupt/i,
]

export const TMUX_TIMER_PATTERN = /\(\d+s[^)]*\)/g
export const TMUX_UI_GLYPH_PATTERN = /[•❯⏵⏺↵]/g
export const TMUX_PROMPT_PREFIX = /^[\s>*#$❯]+/

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '')
}

export function isDecorativeLine(line: string): boolean {
  return TMUX_DECORATIVE_LINE_PATTERN.test(line)
}

export function isMetadataLine(
  line: string,
  patterns: ReadonlyArray<RegExp>
): boolean {
  return patterns.some((pattern) => pattern.test(line))
}

export function cleanTmuxLine(line: string): string {
  return stripAnsi(line)
    .replace(TMUX_TIMER_PATTERN, '')
    .replace(TMUX_UI_GLYPH_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
