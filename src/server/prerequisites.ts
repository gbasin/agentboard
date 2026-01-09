export function ensureTmux(): void {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.toString() || 'tmux not found')
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'tmux not found'
    throw new Error(
      `tmux is required to run Agentboard. Install it with: brew install tmux. (${message})`
    )
  }
}
