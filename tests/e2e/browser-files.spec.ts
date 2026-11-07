// All terminal state, processes, data and logs are isolated by playwright.config.
import { spawnSync } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '@playwright/test'
const repl = fileURLToPath(new URL('./fixtures/paste-repl.py', import.meta.url))
const tmux = (args: string[]) => spawnSync('tmux', args, { encoding: 'utf8', env: { ...process.env } })
for (const mode of ['desktop', 'mobile', 'drop', 'context-paste'] as const) {
  test(`${mode}: files go directly into the existing prompt without submitting`, async ({ page }) => {
    const session = process.env.E2E_TMUX_SESSION
    if (!session || !process.env.E2E_TMUX_TMPDIR) throw new Error('Private e2e tmux server required')
    await page.setViewportSize(mode === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 })
    const name = `file-paste-${mode}`
    const target = `${session}:${name}`
    expect(tmux(['new-window', '-t', session, '-n', name, `python3 ${repl}`]).status).toBe(0)
    const uploads: Promise<string>[] = []
    const cleanupPaths: string[] = []
    const hostClipboardRequests: string[] = []
    page.on('request', request => { if (request.url().includes('clipboard-file-path')) hostClipboardRequests.push(request.url()) })
    page.on('response', response => {
      if (/\/api\/paste-(file|image)$/.test(response.url()) && response.ok()) {
        uploads.push(response.json().then(body => {
          cleanupPaths.push(response.url().endsWith('/api/paste-file') ? dirname(body.path) : body.path)
          return body.path
        }))
      }
    })
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
        // Paste actual PNG bytes, then remove the first image to exercise row reuse.
        await page.getByRole('textbox', { name: 'Paste here' }).evaluate(async input => {
          const transfer = new DataTransfer()
          for (const [index, name] of ['remove.png', 'keep.png'].entries()) {
            const canvas = document.createElement('canvas')
            canvas.width = (index + 1) * 32
            canvas.height = 32
            const context = canvas.getContext('2d')!
            context.fillStyle = index === 0 ? '#21665b' : '#eac47a'
            context.fillRect(0, 0, canvas.width, canvas.height)
            const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)))
            transfer.items.add(new File([blob], name, { type: 'image/png' }))
          }
          input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
        })
        const previews = page.getByRole('dialog').locator('img')
        await expect(previews).toHaveCount(2)
        await expect.poll(() => previews.evaluateAll(images => images.every(image => (image as HTMLImageElement).naturalWidth > 0))).toBe(true)
        await page.getByRole('button', { name: 'Remove remove.png', exact: true }).click()
        await expect(previews).toHaveCount(1)
        await expect(previews).toHaveAttribute('alt', 'Preview of keep.png')
        await expect.poll(() => previews.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(64)
        expect(uploads).toHaveLength(0)
        await page.screenshot({ path: test.info().outputPath('paste-thumbnail-mobile.png') })
        await test.info().attach('Mobile paste thumbnail', { path: test.info().outputPath('paste-thumbnail-mobile.png'), contentType: 'image/png' })
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
        await expect.poll(() => uploads.length).toBe(3)
        expect(await readFile((await Promise.all(uploads))[1], 'utf8')).toBe('second device file')
        expect((await readFile((await Promise.all(uploads))[2])).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      }
      // Only an explicit Enter submits the accumulated typed + pasted prompt.
      await page.locator('.xterm-helper-textarea').press('Enter')
      await expect.poll(() => tmux(['capture-pane', '-t', target, '-p', '-J']).stdout).toContain('SUBMITTED:Compare: ')
    } finally {
      tmux(['kill-window', '-t', target])
      await Promise.all(uploads)
      for (const path of cleanupPaths) await rm(path, { recursive: true, force: true })
    }
  })
}
