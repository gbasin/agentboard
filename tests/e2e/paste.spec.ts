// E2E: pasted multi-line text must be delivered as ONE bracketed paste (held
// for editing), never auto-submitted line-by-line. Regression test for the
// no-flicker/fullscreen auto-send bug: the REPL fixture enables bracketed
// paste BEFORE the browser attaches, so the browser xterm never sees ?2004h
// and the server-side tmux paste-buffer path is the only thing bracketing.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

const WINDOW_NAME = 'paste-repl'
const REPL_PATH = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))

function tmux(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout ?? '' }
}

function capturePane(target: string): string {
  return tmux(['capture-pane', '-t', target, '-p']).stdout
}

async function waitForPaneText(
  target: string,
  needle: string,
  timeoutMs = 10000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let content = ''
  while (Date.now() < deadline) {
    content = capturePane(target)
    if (content.includes(needle)) return content
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(needle)} in pane ${target}. Last content:\n${content}`
  )
}

test('multi-line text paste is held for editing, not auto-submitted', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')
  const target = `${session}:${WINDOW_NAME}`

  // Start the bracketed-paste REPL in a fresh window of the e2e session.
  // It enables ?2004h now — before the browser attaches — which is the exact
  // scenario where client-side bracketing (xterm terminal.paste) fails.
  const created = tmux([
    'new-window',
    '-t',
    session!,
    '-n',
    WINDOW_NAME,
    `python3 ${REPL_PATH}`,
  ])
  expect(created.status).toBe(0)

  try {
    await waitForPaneText(target, 'PASTE-REPL READY')

    // Attach to the REPL window through the real UI.
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: WINDOW_NAME }).first()
    await expect(card).toBeVisible({ timeout: 20000 })
    await card.click()
    await expect(page.locator('.xterm')).toBeVisible()
    await page.waitForTimeout(2000) // let the terminal attach settle

    // Synthesize a real paste: modifier+V keydown on the xterm helper
    // textarea, then a ClipboardEvent carrying multi-line text/plain (the
    // capture-phase listener reads clipboardData synchronously).
    await page.evaluate(() => {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
      const isMac = /Mac/.test(navigator.platform)
      textarea.focus()
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'v',
          code: 'KeyV',
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true,
        })
      )
      const dt = new DataTransfer()
      dt.setData('text/plain', 'e2e_alpha\ne2e_beta')
      textarea.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      )
    })

    // The paste must arrive as ONE held bracketed paste (newlines rendered
    // as '|' by the fixture) with nothing submitted.
    const afterPaste = await waitForPaneText(target, 'HELD:e2e_alpha|e2e_beta')
    expect(afterPaste).not.toContain('SUBMITTED:')

    // An explicit Enter still submits the held buffer.
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.press('Enter')
    await waitForPaneText(target, 'SUBMITTED:e2e_alpha|e2e_beta')
  } finally {
    tmux(['kill-window', '-t', target])
  }
})
