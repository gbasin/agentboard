// tailscale.ts - Tailscale IPv4 lookup for the extra listener and the UI link.
//
// `tailscale ip -4` talks to tailscaled and can take hundreds of ms (441 ms
// on the live host, 4-16 s on a loaded machine). It used to run through
// Bun.spawnSync before the server finished starting; Bun.spawn keeps the
// event loop free while it waits.

import { timedSpawnAsync } from './syncSpawnTiming'

// Standalone CLI on PATH first, then the Mac App Store bundle.
const TAILSCALE_PATHS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

export async function getTailscaleIp(): Promise<string | null> {
  for (const tsPath of TAILSCALE_PATHS) {
    try {
      const result = await timedSpawnAsync([tsPath, 'ip', '-4'])
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
