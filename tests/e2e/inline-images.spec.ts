// Real pane → tmux passthrough → PTY → WebSocket → xterm image decoding.
// Verify decoded pixels, including after reconstruction from text-only history.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { sanitizedTmuxEnv } from '../../src/server/tmuxEnv'

const fixture = fileURLToPath(new URL('./fixtures/inline-images.py', import.meta.url))

function tmux(args: string[]) {
  if (!process.env.E2E_TMUX_TMPDIR) throw new Error('Requires an isolated tmux socket')
  return spawnSync('tmux', ['-L', 'default', ...args], {
    env: sanitizedTmuxEnv(), encoding: 'utf8', timeout: 5000,
  })
}

function imagePixels(page: Page) {
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
    return { red, blue }
  })
}

for (const mobile of [false, true]) {
  test.describe(mobile ? 'mobile' : 'desktop', () => {
    test.use(mobile ? {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    } : { viewport: { width: 1280, height: 800 } })

    for (const protocol of ['iterm', 'sixel']) {
      test(`${protocol} images render and redraw after refresh`, async ({ page }, testInfo) => {
        test.setTimeout(60000)
        const session = process.env.E2E_TMUX_SESSION
        test.skip(!session, 'Requires the isolated e2e tmux server')
        const name = `images-${protocol}-${mobile ? 'mobile' : 'desktop'}`
        const target = `${session}:${name}`
        const created = tmux(['new-window', '-t', session!, '-n', name, `python3 '${fixture}' ${protocol}`])
        expect(created.status, created.stderr).toBe(0)

        const select = async () => {
          const card = page.getByTestId('session-card').filter({ hasText: name }).first()
          await card.waitFor({ state: 'attached', timeout: 20000 })
          await card.evaluate(el => (el as HTMLElement).click())
          await expect(page.locator('.xterm')).toBeVisible()
        }
        const render = async () => {
          // Re-emit until attached; tmux cannot replay earlier graphics.
          await expect.poll(async () => {
            const sent = tmux(['send-keys', '-t', target, 'Enter'])
            expect(sent.status, sent.stderr).toBe(0)
            await page.waitForTimeout(250) // PTY delivery and asynchronous image decode
            return imagePixels(page)
          }, { timeout: 15000 }).toEqual({ red: 3600, blue: 3600 })
        }

        try {
          await page.goto('/')
          await select()
          await render()
          await page.reload()
          await select()
          // A fresh terminal has text history, not stale graphics from a previous mount.
          await expect.poll(() => imagePixels(page)).toEqual({ red: 0, blue: 0 })
          await render()
          const screenshot = testInfo.outputPath(`${protocol}-${mobile ? 'mobile' : 'desktop'}.png`)
          await page.screenshot({ path: screenshot })
          await testInfo.attach(`${protocol}-${mobile ? 'mobile' : 'desktop'}`, {
            path: screenshot, contentType: 'image/png',
          })
        } finally {
          tmux(['kill-window', '-t', target])
        }
      })
    }
  })
}
