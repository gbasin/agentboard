// All terminal state, processes, data and logs are isolated by playwright.config.
import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
const repl = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))
const tmux = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8' })
for (const mode of ['desktop', 'mobile', 'drop', 'context-paste'] as const) {
  test(`${mode}: files go directly into the existing prompt without submitting`, async ({ page }) => {
    const session = process.env.E2E_TMUX_SESSION
    if (!session || !process.env.E2E_TMUX_TMPDIR) throw new Error('Private e2e tmux server required')
    await page.setViewportSize(mode === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    const name = `file-paste-${mode}`
    const target = `${session}:${name}`
    expect(tmux(['new-window', '-t', session, '-n', name, `python3 ${repl}`]).status).toBe(0)
    const uploads: Promise<string>[] = []
    const hostClipboardRequests: string[] = []
    page.on('request', request => { if (request.url().includes('clipboard-file-path')) hostClipboardRequests.push(request.url()) })
    page.on('response', response => { if (response.url().endsWith('/api/paste-file') && response.ok()) uploads.push(response.json().then(body => body.path)) })
    try {
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p', '-J']).stdout).toContain('PASTE-REPL READY')
      await page.goto('/')
      if (mode === 'mobile') await page.getByRole('button', { name: 'Open session menu' }).click()
      const list = mode === 'mobile' ? page.getByRole('dialog', { name: 'Session list' }) : page
      const card = list.getByTestId('session-card').filter({ hasText: name }).first()
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.click()
      await expect(page.locator('.xterm')).toBeVisible()
      await page.waitForTimeout(1500)
      if (mode === 'mobile') await page.getByRole('button', { name: 'Show keyboard' }).click()
      await expect(page.locator('.xterm-helper-textarea')).toBeEnabled()
      await page.locator('.xterm-helper-textarea').pressSequentially('Compare: ')
      const uploaded = page.waitForResponse(response => response.url().endsWith('/api/paste-file') && response.ok())
      if (mode === 'mobile') {
        await expect(page.getByRole('button', { name: 'Choose files', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'Paste', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'Paste from this device' })).toBeVisible()
        const chooser = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: 'Choose files', exact: true }).click()
        await (await chooser).setFiles([
          { name: 'data with spaces.unknown', mimeType: 'application/octet-stream', buffer: Buffer.from('exact device file bytes') },
          { name: 'LICENSE', mimeType: 'text/plain', buffer: Buffer.from('second device file') },
        ])
        await page.getByRole('button', { name: 'Submit', exact: true }).click()
      } else {
        await page.evaluate((mode) => {
          const input = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
          const transfer = new DataTransfer()
          transfer.items.add(new File(['exact device file bytes'], 'data with spaces.unknown'))
          if (mode === 'drop') {
            document.querySelector('[data-testid="terminal-panel"]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
          } else {
            input.focus()
            if (mode === 'desktop') {
              const isMac = /Mac/.test(navigator.platform)
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }))
            }
            input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
          }
        }, mode)
      }
      const { path } = await (await uploaded).json()
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p', '-J']).stdout).toContain('data with spaces.unknown')
      const pane = tmux(['capture-pane', '-t', target, '-p', '-J']).stdout
      expect(pane).not.toContain('SUBMITTED:')
      await expect(page.getByRole('dialog', { name: /Paste/ })).toHaveCount(0)
      expect(hostClipboardRequests).toEqual([])
      expect(await readFile(path, 'utf8')).toBe('exact device file bytes')
      if (mode === 'mobile') {
        await expect.poll(() => tmux(['capture-pane', '-t', target, '-p', '-J']).stdout).toContain('LICENSE')
        expect(uploads).toHaveLength(2)
        expect(await readFile((await Promise.all(uploads))[1], 'utf8')).toBe('second device file')
      }
      // Only an explicit Enter submits the accumulated typed + pasted prompt.
      await page.locator('.xterm-helper-textarea').press('Enter')
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p', '-J']).stdout).toContain('SUBMITTED:Compare: ')
    } finally {
      tmux(['kill-window', '-t', target])
      for (const path of await Promise.all(uploads)) await rm(dirname(path), { recursive: true, force: true })
    }
  })
}
