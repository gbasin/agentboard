// tailscale.ts - Tailscale IPv4 lookup for the extra listener and the UI link.
//
// `tailscale ip -4` talks to tailscaled and can take hundreds of ms (441 ms
// on the live host, 4-16 s on a loaded machine). It used to run through
// Bun.spawnSync before the server finished starting; Bun.spawn keeps the
// event loop free while it waits.

import { timedSpawnAsync } from './syncSpawnTiming'

// Standalone CLI on PATH first, then the Mac App Store bundle.
const TAILSCALE_PATHS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

// A hung tailscaled would otherwise leave one `tailscale ip` process and one
// pending /api/server-info request behind per call. The lookup is display and
// listener setup only, so giving up returns null (no Tailscale address).
export const TAILSCALE_LOOKUP_TIMEOUT_MS = 5000

export async function getTailscaleIp(
  timeoutMs: number = TAILSCALE_LOOKUP_TIMEOUT_MS
): Promise<string | null> {
  for (const tsPath of TAILSCALE_PATHS) {
    try {
      const result = await timedSpawnAsync([tsPath, 'ip', '-4'], { timeout: timeoutMs })
      // Killed at the timeout: tailscaled is not answering. The other path
      // talks to the same daemon, so don't wait on it as well.
      if (result.signalCode) return null
      if (result.exitCode === 0) {
        const ip = result.stdout.trim()
        if (ip) return ip
      }
    } catch {
      // Not installed at this path - try the next one
    }
  }
  return null
}
