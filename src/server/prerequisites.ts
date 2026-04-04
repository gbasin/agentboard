import { config } from './config'
import { TmuxTimeoutError } from './tmuxTimeout'

export function ensureTmux(): void {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: config.tmuxTimeoutMs,
    })

    if (result.signalCode === 'SIGTERM' || result.exitCode === null) {
      throw new TmuxTimeoutError('probe', config.tmuxTimeoutMs)
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || 'tmux not found')
    }
  } catch (error) {
    if (error instanceof TmuxTimeoutError) {
      throw new Error(
        `tmux is installed but did not respond to the startup probe within ${config.tmuxTimeoutMs}ms. Ensure tmux is running and responsive. (${error.message})`,
        { cause: error }
      )
    }
    const message =
      error instanceof Error ? error.message : 'tmux not found'
    throw new Error(
      `tmux is required to run Agentboard. Install it with: brew install tmux. (${message})`,
      { cause: error }
    )
  }
}
