/** Wait for cold Simulator scheduling pressure to subside before backend startup.
 * Probe only tmux's version: no server, session, or mutation is retried.
 */
export async function waitForTmux(options: {
  budgetMs?: number
  probeMs?: number
  intervalMs?: number
  probe?: (timeoutMs: number) => Promise<boolean>
} = {}) {
  const deadline = Date.now() + (options.budgetMs ?? 120_000)
  const probeMs = options.probeMs ?? 3000
  const probe = options.probe ?? (async timeoutMs => {
    const child = Bun.spawn(['tmux', '-V'], {
      env: { ...globalThis.process.env, TMUX: undefined },
      stdout: 'ignore', stderr: 'ignore', timeout: timeoutMs,
    })
    return await child.exited === 0
  })
  let consecutive = 0
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    if (await probe(Math.min(probeMs, remaining))) {
      if (++consecutive === 3) return
    } else {
      consecutive = 0
    }
    await Bun.sleep(Math.min(options.intervalMs ?? 1000, Math.max(0, deadline - Date.now())))
  }
  throw new Error('tmux did not respond reliably within the CI startup budget; inspect Simulator resource diagnostics')
}

if (import.meta.main) await waitForTmux()
