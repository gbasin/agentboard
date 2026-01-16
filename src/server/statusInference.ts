// statusInference.ts - Shared status inference logic
// Used by both SessionManager and sessionRefreshWorker

import {
  stripAnsi,
  TMUX_DECORATIVE_LINE_PATTERN,
  TMUX_METADATA_STATUS_PATTERNS,
  TMUX_TIMER_PATTERN,
  TMUX_UI_GLYPH_PATTERN,
} from './terminal/tmuxText'

// Permission prompt patterns for Claude Code and Codex CLI
export const PERMISSION_PATTERNS: RegExp[] = [
  // Claude Code: numbered selection menu with navigation hint (AskUserQuestion)
  /❯\s*\d+\.\s+\S+[\s\S]*?Esc to cancel/,
  // Claude Code: numbered options like "❯ 1. Yes" or "1. Yes"
  /[❯>]?\s*1\.\s*(Yes|Allow)/i,
  // Claude Code: "Do you want to proceed?" or similar
  /do you want to (proceed|continue|allow|run)\?/i,
  // Claude Code: "Yes, and don't ask again" style options
  /yes,?\s*(and\s+)?(don't|do not|never)\s+ask\s+again/i,
  // Claude Code: permission prompt with session option
  /yes,?\s*(for|during)\s+this\s+session/i,
  // Codex CLI: approve/reject inline prompts
  /\[(approve|accept)\].*\[(reject|deny)\]/i,
  // Codex CLI: "approve this" prompts
  /approve\s+this\s+(command|change|action)/i,
  // Generic: "allow" / "deny" choice pattern
  /\[allow\].*\[deny\]/i,
  // Generic: "y/n" or "[Y/n]" prompts at end of question
  /\?\s*\[?[yY](es)?\/[nN](o)?\]?\s*$/m,
]

// Detects if terminal content shows a permission prompt
export function detectsPermissionPrompt(content: string): boolean {
  const cleaned = stripAnsi(content)
  // Focus on the last ~30 lines where prompts typically appear
  // First strip trailing blank lines (terminal buffer often has many)
  const lines = cleaned.split('\n')
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') {
    lines.pop()
  }
  const recentContent = lines.slice(-30).join('\n')
  return PERMISSION_PATTERNS.some((pattern) => pattern.test(recentContent))
}

// Normalize content for comparison - strips noise from terminal output
export function normalizeContent(content: string): string {
  const lines = stripAnsi(content).split('\n')
  return lines
    .slice(-20)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !TMUX_DECORATIVE_LINE_PATTERN.test(line))
    .filter(
      (line) =>
        !TMUX_METADATA_STATUS_PATTERNS.some((pattern) => pattern.test(line))
    )
    .map((line) => line.replace(TMUX_TIMER_PATTERN, '').trim())
    .map((line) => line.replace(TMUX_UI_GLYPH_PATTERN, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenizeNormalized(content: string): string[] {
  return content
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

export interface TokenOverlapStats {
  overlap: number
  leftSize: number
  rightSize: number
  ratioMin: number
  ratioMax: number
}

export function getTokenOverlapStats(left: string, right: string): TokenOverlapStats {
  const leftTokens = tokenizeNormalized(left)
  const rightTokens = tokenizeNormalized(right)
  const leftSet = new Set(leftTokens)
  const rightSet = new Set(rightTokens)
  let overlap = 0
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1
    }
  }
  const leftSize = leftSet.size
  const rightSize = rightSet.size
  const minSize = Math.min(leftSize, rightSize)
  const maxSize = Math.max(leftSize, rightSize)
  const ratioMin = minSize === 0 ? 1 : overlap / minSize
  const ratioMax = maxSize === 0 ? 1 : overlap / maxSize
  return { overlap, leftSize, rightSize, ratioMin, ratioMax }
}

export interface ResizeChangeResult extends TokenOverlapStats {
  changed: boolean
}

export function isMeaningfulResizeChange(
  oldNormalized: string,
  newNormalized: string
): ResizeChangeResult {
  if (oldNormalized === newNormalized) {
    return { changed: false, ...getTokenOverlapStats(oldNormalized, newNormalized) }
  }
  const stats = getTokenOverlapStats(oldNormalized, newNormalized)
  const maxSize = Math.max(stats.leftSize, stats.rightSize)
  if (maxSize < 8) {
    return { changed: true, ...stats }
  }
  const changed = stats.ratioMin < 0.9
  return { changed, ...stats }
}
