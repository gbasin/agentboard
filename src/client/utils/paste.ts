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
 * Strip C0 control characters and DEL from a file path before it's delivered to
 * the terminal. A legitimate image path never contains these, but a crafted
 * filename could embed ESC / the bracketed-paste end marker and break out of
 * the paste sequence to inject terminal control codes.
 */
export function sanitizeImagePath(path: string): string {
  // eslint-disable-next-line no-control-regex
  return path.replace(/[\x00-\x1f\x7f]/g, '')
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
  const clean = sanitizeImagePath(path)
  return agentType === 'codex' ? clean : bracketedPaste(clean)
}
