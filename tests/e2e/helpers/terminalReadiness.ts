import { expect, type Page } from '@playwright/test'

/** Install before navigation so fast attaches cannot outrun the observer. */
export function observeTerminalReadiness(page: Page) {
  const ready = new Set<string>()
  const output = new Map<string, string>()
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload))
      if (frame.type === 'terminal-ready') ready.add(frame.sessionId)
      if (frame.type === 'terminal-output') {
        output.set(frame.sessionId, ((output.get(frame.sessionId) ?? '') + frame.data).slice(-65536))
      }
    } catch { /* Ignore non-JSON frames. */ }
  }))
  return async (sessionId: string, marker: string, mouse = false) => {
    await expect.poll(() => ({ ready: ready.has(sessionId), output: output.get(sessionId) ?? '' }), {
      message: `Terminal ${sessionId} must attach and deliver ${marker}`,
      timeout: 10000,
    }).toMatchObject({ ready: true, output: expect.stringContaining(marker) })
    // Mobile intentionally disables text input until the user taps the terminal.
    await expect(page.locator('.xterm')).toBeVisible()
    if (mouse) await expect(page.locator('.xterm.enable-mouse-events')).toBeVisible()
  }
}
