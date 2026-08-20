import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const REPL_PATH = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

async function waitForPaneText(
  target: string,
  needle: string,
  timeoutMs = 10000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = tmux(['capture-pane', '-t', target, '-p']).stdout
    if (content.includes(needle)) return content
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in pane ${target}. Last content:\n${content}`
  )
}

async function exerciseManualPaste(page: Page, windowName: string) {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${windowName}`

  const created = tmux([
    'new-window',
    '-t',
    session!,
    '-n',
    windowName,
    `python3 ${REPL_PATH}`,
  ])
  expect(created.status).toBe(0)

  try {
    await waitForPaneText(target, 'PASTE-REPL READY')

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          read: () => Promise.reject(new Error('clipboard permission denied')),
          readText: () => Promise.reject(new Error('clipboard permission denied')),
        },
      })
    })

    await page.goto('/')
    await page.getByRole('button', { name: 'Open session menu' }).click()
    const drawer = page.getByRole('dialog', { name: 'Session list' })
    const card = drawer.getByTestId('session-card').filter({ hasText: windowName })
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.click()
    await expect(page.locator('.xterm')).toBeVisible()

    const pasteButton = page.locator('button[aria-label="Paste"]')
    await expect(pasteButton).toBeVisible({ timeout: 20000 })
    await pasteButton.click()
    const textarea = page.getByRole('textbox', { name: 'Paste text' })
    await expect(textarea).toBeVisible()

    const dialogBounds = await textarea.locator('xpath=..').boundingBox()
    expect(dialogBounds).not.toBeNull()
    expect(dialogBounds!.x).toBeGreaterThanOrEqual(0)
    expect(dialogBounds!.y).toBeGreaterThanOrEqual(0)
    expect(dialogBounds!.x + dialogBounds!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width
    )
    expect(dialogBounds!.y + dialogBounds!.height).toBeLessThanOrEqual(
      page.viewportSize()!.height
    )

    await textarea.fill('manual_alpha\nmanual_beta')
    await textarea.press('Enter')
    await expect(textarea).toHaveValue('manual_alpha\nmanual_beta\n')

    // Approximate the reduced visual viewport while the iOS keyboard is open.
    await page.setViewportSize({ width: 430, height: 500 })
    await page.waitForTimeout(100)
    const compactBounds = await textarea.locator('xpath=..').boundingBox()
    expect(compactBounds).not.toBeNull()
    expect(compactBounds!.y).toBeGreaterThanOrEqual(0)
    expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(500)

    const sendButton = page.getByRole('button', { name: 'Send' })
    await expect(sendButton).toBeVisible()
    await sendButton.click()

    const pane = await waitForPaneText(target, 'HELD:manual_alpha|manual_beta|')
    expect(pane).not.toContain('SUBMITTED:')
  } finally {
    tmux(['kill-window', '-t', target])
  }
}

test.describe('iOS PWA-sized manual paste fallback', () => {
  test.use({
    viewport: { width: 430, height: 932 },
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
  })

  test('preserves multiline text and stays within the viewport', async ({ page }) => {
    await exerciseManualPaste(page, 'manual-paste-mobile')
  })
})
