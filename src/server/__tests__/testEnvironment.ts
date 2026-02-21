export function isTmuxAvailable(): boolean {
  try {
    const result = Bun.spawnSync(['tmux', '-V'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return result.exitCode === 0
  } catch {
    return false
  }
}

export function canBindLocalhost(): boolean {
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('ok'),
    })
    return true
  } catch {
    return false
  } finally {
    server?.stop(true)
  }
}
