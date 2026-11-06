/**
 * snapshotText - text shaping for the "Select text" snapshot layer.
 *
 * displaySnapshotText keeps one entry per captured line (so the layer can
 * align the visible screen with the terminal underneath); cleanSnapshotText
 * is what "Copy all" puts on the pasteboard.
 */

const TRAILING_WS = /[ \t ]+$/

/** Strip trailing whitespace per line but keep every line, blank or not. */
export function displaySnapshotText(text: string): string {
  return text.split('\n').map((line) => line.replace(TRAILING_WS, '')).join('\n')
}

/** Per-line trailing whitespace stripped, then trailing blank lines dropped. */
export function cleanSnapshotText(text: string): string {
  const lines = displaySnapshotText(text).split('\n')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}
