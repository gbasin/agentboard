/**
 * paneSnapshot - one-shot plain-text capture of a tmux pane for the client's
 * "Select text" mode. Reads pane state first, then captures the joined text:
 * the scrollback plus the visible screen on the main screen, the visible
 * screen only on the alternate screen (there the history is the stale shell
 * output from before the fullscreen app started, not the app's content).
 */

export const SNAPSHOT_HISTORY_LINES = 3000

export interface TmuxRunResult {
  exitCode: number | null
  stdout: string
}

/** Runs one tmux command (args exclude the `tmux` binary itself). */
export type TmuxRunner = (args: string[]) => Promise<TmuxRunResult>

export interface PaneSnapshot {
  text: string
  /** Lines of tmux history included above the visible screen. */
  historyLines: number
  /** Lines the pane is scrolled up in tmux copy-mode (0 when live). */
  scrollPosition: number
  altScreen: boolean
}

const STATE_FORMAT = '#{alternate_on},#{history_size},#{pane_in_mode},#{scroll_position}'

export function parsePaneState(output: string) {
  const [alt, history, inMode, scroll] = output.trim().split(',')
  const toInt = (value: string | undefined) => {
    const parsed = Number.parseInt(value ?? '', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }
  return {
    altScreen: alt === '1',
    historySize: toInt(history),
    scrollPosition: inMode === '1' ? toInt(scroll) : 0,
  }
}

export async function capturePaneSnapshot(
  target: string,
  run: TmuxRunner
): Promise<PaneSnapshot | null> {
  const stateResult = await run(['display-message', '-p', '-t', target, STATE_FORMAT])
  if (stateResult.exitCode !== 0) return null
  const state = parsePaneState(stateResult.stdout)
  const historyLines = state.altScreen ? 0 : Math.min(state.historySize, SNAPSHOT_HISTORY_LINES)
  const startArgs = historyLines > 0 ? ['-S', `-${historyLines}`] : []
  const capture = await run(['capture-pane', '-p', '-J', ...startArgs, '-t', target])
  if (capture.exitCode !== 0) return null
  // capture-pane ends every line with \n; drop the final one so the client
  // gets exactly one entry per captured line.
  const text = capture.stdout.endsWith('\n') ? capture.stdout.slice(0, -1) : capture.stdout
  return {
    text,
    historyLines,
    scrollPosition: Math.min(state.scrollPosition, historyLines),
    altScreen: state.altScreen,
  }
}
