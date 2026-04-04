import { config } from './config'

export function ensureTmux(): void {
  try {
    const startedAt = Date.now()
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: config.tmuxTimeoutMs,
    })

    const elapsedMs = Date.now() - startedAt
    if (result.signalCode === 'SIGTERM' || result.exitCode === null || elapsedMs >= config.tmuxTimeoutMs) {
      throw new Error(`tmux probe timed out after ${config.tmuxTimeoutMs}ms`)
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || 'tmux not found')
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'tmux not found'
    throw new Error(
      `tmux is required to run Agentboard. Install it with: brew install tmux. (${message})`,
      { cause: error }
    )
  }
}
