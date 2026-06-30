import type { AgentType } from '@shared/types'

/**
 * Wrap text in bracketed-paste markers so the attached agent treats it as a
 * paste rather than typed input. Claude Code attaches an image when it receives
 * the image's file path inside a bracketed paste (a raw-typed path is just
 * inserted as literal text).
 */
export function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

/**
 * Build the terminal-input payload that delivers an uploaded image's file path
 * to the attached agent so it attaches the image.
 *
 * Claude (and unknown agents) get the path wrapped in a bracketed paste, which
 * produces a native [Image #N] attachment. Codex is left untouched — it
 * attaches images via its own clipboard path, not a typed file path, so we send
 * the raw path exactly as before.
 */
export function imagePathInput(
  path: string,
  agentType: AgentType | undefined
): string {
  return agentType === 'codex' ? path : bracketedPaste(path)
}
