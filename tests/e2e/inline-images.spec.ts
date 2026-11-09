// Exercise graphics across the real pane → tmux passthrough → PTY → WebSocket
// → xterm image addon path. A canvas alone is insufficient: verify its pixels.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
import { sanitizedTmuxEnv } from '../../src/server/tmuxEnv'

const fixture = fileURLToPath(new URL('./fixtures/inline-images.py', import.meta.url))

function tmux(args: string[]) {
  return spawnSync('tmux', ['-L', 'default', ...args], {
    env: sanitizedTmuxEnv(),
    encoding: 'utf8',
  })
}

test('iTerm images render through tmux passthrough', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'Requires the isolated e2e tmux server')
  const target = `${session}:inline-images`
  const created = tmux(['new-window', '-t', session!, '-n', 'inline-images', `python3 '${fixture}'`])
  expect(created.status, created.stderr).toBe(0)
  try {
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: 'inline-images' }).first()
    await card.waitFor({ state: 'attached', timeout: 20000 })
    await card.evaluate(el => (el as HTMLElement).click())
    await expect(page.locator('.xterm')).toBeVisible()

    // Re-emit until attach completes. Graphics sent before the client attaches
    // cannot be recovered from tmux's text-only capture-pane snapshot.
    await expect.poll(async () => {
      const sent = tmux(['send-keys', '-t', target, 'Enter'])
      expect(sent.status, sent.stderr).toBe(0)
      // Allow the PTY frame and asynchronous browser image decoding to land
      // before sampling; another Enter clears and redraws both images.
      await page.waitForTimeout(250)
      return page.locator('.xterm-image-layer').evaluateAll(canvases => {
        let red = 0
        let blue = 0
        for (const canvas of canvases as HTMLCanvasElement[]) {
          const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] === 255 && pixels[i + 1] === 0 && pixels[i + 2] === 0 && pixels[i + 3] === 255) red++
            if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 255 && pixels[i + 3] === 255) blue++
          }
        }
        return { red, blue, layers: canvases.length }
      })
    }, { timeout: 15000 }).toEqual({ red: 4096, blue: 4096, layers: 1 })
    await page.screenshot({ path: testInfo.outputPath('inline-images.png') })
  } finally {
    await page.screenshot({ path: testInfo.outputPath('inline-images-final.png') })
    tmux(['kill-window', '-t', target])
  }
})
