// Browser files travel through the upload API and remain an editable paste in
// the pane. Playwright config isolates tmux, DB, logs, and the server port.
import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'

const repl = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))
const tmux = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8' })

for (const mode of ['desktop', 'mobile'] as const) {
  test(`${mode}: paste text and device files without submitting the prompt`, async ({ page }) => {
    const session = process.env.E2E_TMUX_SESSION
    if (!session || !process.env.E2E_TMUX_TMPDIR) throw new Error('Private e2e tmux server required')
    await page.setViewportSize({ width: 1440, height: 900 })
    const name = `file-paste-${mode}`
    const target = `${session}:${name}`
    expect(tmux(['new-window', '-t', session, '-n', name, `python3 ${repl}`]).status).toBe(0)
    const uploads: string[] = []
    const hostClipboardRequests: string[] = []
    page.on('request', (request) => { if (request.url().includes('clipboard-file-path')) hostClipboardRequests.push(request.url()) })
    try {
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p']).stdout).toContain('PASTE-REPL READY')
      await page.goto('/')
      const card = page.getByTestId('session-card').filter({ hasText: name }).first()
      await expect(card).toBeVisible({ timeout: 20000 })
      await card.click()
      await expect(page.locator('.xterm')).toBeVisible()
      if (mode === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(2000)
      if (mode === 'desktop') {
        await page.evaluate(() => {
          const input = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
          input.focus()
          const isMac = /Mac/.test(navigator.platform)
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }))
          const clipboardData = new DataTransfer()
          clipboardData.items.add(new File(['document bytes'], 'report.docx'))
          input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
        })
      } else {
        await page.getByRole('button', { name: 'Paste', exact: true }).click()
      }
      const dialog = page.getByRole('dialog', { name: 'Paste', exact: true })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('textbox', { name: 'Paste text' }).fill('Compare these\nand keep the prompt editable:')
      await dialog.getByLabel('Choose files', { exact: true }).setInputFiles({ name: 'data with spaces.unknown', mimeType: 'application/octet-stream', buffer: Buffer.from('exact device file bytes') })
      page.on('response', async (response) => {
        if (response.url().endsWith('/api/paste-file') && response.ok()) uploads.push((await response.json()).path)
      })
      const uploaded = page.waitForResponse((response) => response.url().endsWith('/api/paste-file') && response.ok())
      await dialog.getByRole('button', { name: 'Send', exact: true }).click()
      const first = await (await uploaded).json() as {path: string}
      await expect(dialog).not.toBeVisible()
      const pane = tmux(['capture-pane', '-t', target, '-p']).stdout
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p']).stdout).toContain('HELD:Compare these|and keep the prompt editable:')
      const content = tmux(['capture-pane', '-t', target, '-p']).stdout
      expect(content).toContain('data with spaces.unknown')
      expect(content).not.toContain('SUBMITTED:')
      expect(pane).not.toContain('SUBMITTED:')
      expect(hostClipboardRequests).toEqual([])
      if (mode === 'mobile') expect(await readFile(first.path, 'utf8')).toBe('exact device file bytes')
      if (mode === 'desktop') expect(await readFile(first.path, 'utf8')).toBe('document bytes')
    } finally {
      tmux(['kill-window', '-t', target])
      for (const path of uploads) await rm(dirname(path), { recursive: true, force: true })
    }
  })
}
