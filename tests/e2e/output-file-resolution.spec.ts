/** Real subagent evidence → bare filename → served report, including ambiguous/missing recovery. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { mediaFixture } from './helpers/mediaFixture'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ timeout: 180_000 })
const reply = (text: string) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const write = (file: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: file, content: '<h1>Motion ideas</h1>' } }] } }) + '\n'

for (const mobile of [false, true]) {
  test(`session filename recovery: ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, info) => {
    const fixture = await mediaFixture(request, 0)
    const root = fs.mkdtempSync(path.join(process.env.E2E_TMUX_TMPDIR!, 'reports-'))
    const report = path.join(root, '17-motion-ideas.html')
    const alternate = path.join(root, 'alternate', '17-motion-ideas.html')
    const childDir = path.join(fixture.logPath.slice(0, -6), 'subagents')
    fs.mkdirSync(childDir, { recursive: true })
    fs.mkdirSync(path.dirname(alternate))
    fs.writeFileSync(report, '<!doctype html><h1>Motion ideas</h1><button onclick="this.textContent=\'Played\'">Play</button>')
    fs.writeFileSync(path.join(childDir, 'agent-designer.jsonl'), write(report))
    fs.appendFileSync(fixture.logPath, reply('The motion ideas are open: **`17-motion-ideas.html`** in Desktop/ike-review.'))
    try {
      await expect.poll(async () => (await fixture.find())?.mediaSummary?.previews, { timeout: 60_000 }).toBe(1)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.goto('/'); await fixture.select(page)
      if (mobile) await page.setViewportSize({ width: 390, height: 844 })
      await page.getByTestId('media-rail-pill').click()
      await page.getByRole('button', { name: 'Previews 1', exact: true }).click()
      await page.getByTestId('output-item').click()
      const preview = page.getByTestId('output-preview')
      const frame = page.frameLocator('iframe[title="17-motion-ideas.html"]')
      await expect(frame.getByRole('heading', { name: 'Motion ideas' })).toBeVisible()
      await frame.getByRole('button', { name: 'Play', exact: true }).click()
      await expect(frame.getByRole('button', { name: 'Played', exact: true })).toBeVisible()
      await page.screenshot({ path: info.outputPath('resolved.png') })
      // The same bare reference becomes ambiguous after new evidence arrives.
      fs.writeFileSync(alternate, '<!doctype html><h1>Alternate motion ideas</h1>')
      fs.appendFileSync(path.join(childDir, 'agent-designer.jsonl'), write(alternate))
      await preview.getByRole('button', { name: 'Reload', exact: true }).click()
      const choices = preview.getByRole('list', { name: 'Matching session files' })
      await expect(choices.getByRole('button')).toHaveCount(2)
      await expect(preview.locator('iframe')).toHaveCount(0)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      const shot = info.outputPath('choose-file.png')
      await page.screenshot({ path: shot })
      await info.attach('Choose a matching session file', { path: shot, contentType: 'image/png' })
      await choices.getByRole('button', { name: alternate, exact: true }).focus()
      await page.keyboard.press('Enter')
      await expect(frame.getByRole('heading', { name: 'Alternate motion ideas' })).toBeVisible()
      const popupPromise = page.waitForEvent('popup')
      await preview.getByRole('link', { name: 'Open output in new tab' }).click()
      const popup = await popupPromise
      await expect(popup.getByRole('heading', { name: 'Alternate motion ideas' })).toBeVisible()
      await popup.close()
      fs.unlinkSync(alternate); fs.unlinkSync(report)
      await preview.getByRole('button', { name: 'Reload', exact: true }).click()
      await expect(preview.getByRole('alert')).toContainText('no longer a matching session output')
      await preview.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(preview.getByRole('alert')).toContainText('Couldn’t resolve this file')
      await expect(preview.getByRole('alert')).toContainText('Looked for:')
      // Recreating an already-recorded file works without changing the transcript.
      fs.writeFileSync(report, '<h1>Restored motion ideas</h1>')
      await preview.getByRole('button', { name: 'Try again', exact: true }).click()
      await expect(frame.getByRole('heading', { name: 'Restored motion ideas' })).toBeVisible()
    } finally { fixture.cleanup(); fs.rmSync(root, { recursive: true, force: true }) }
  })
}
