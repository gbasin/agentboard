/** Real Claude log → poll worker → database → desktop/mobile session preview. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { mediaFixture, TINY_PNG } from './helpers/mediaFixture'

test.describe.configure({ timeout: 120_000 })
test.use({ serviceWorkers: 'block' })

for (const mobile of [false, true]) {
  test(`Claude API snapshots cannot replace user previews: ${mobile ? 'mobile' : 'desktop'}`, async ({ page, request }, info) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    const fixture = await mediaFixture(request, 0, false, { waitForSummary: false })
    const note = '[Image: original 1206x2622, displayed at 1185x2576. Multiply coordinates by 1.02 to map to original image.]'
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG } }
    const append = (...entries: object[]) => fs.appendFileSync(fixture.logPath, entries.map(entry => JSON.stringify({
      timestamp: new Date().toISOString(), sessionId: fixture.sessionId, ...entry,
    })).join('\n') + '\n')
    const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } })
    const snapshot = (content: unknown) => ({ type: 'api-request-blob', hash: 'fixture-request', message: { role: 'user', content } })
    const preview = async () => (await fixture.find() as { lastUserMessage?: string } | undefined)?.lastUserMessage
    async function openBoard() {
      await page.goto('/')
      if (mobile) await page.getByRole('button', { name: 'Open session menu', exact: true }).first().click()
    }
    try {
      const prompt = `Keep the simulator checks running ${fixture.sessionId.slice(0, 8)}`
      append(
        user(prompt),
        user([{ type: 'tool_result', tool_use_id: 'read-screenshot', content: [image] }]),
        { ...user(note), isMeta: true, turnCompanion: true },
        snapshot([{ type: 'tool_result', tool_use_id: 'read-screenshot', content: [image] }, { type: 'text', text: note }]),
        { type: 'assistant', message: { role: 'assistant', content: 'Screenshot inspected. ' + 'x'.repeat(40_000) } },
      )
      // Positive update proves the poll worker processed the appended batch.
      await expect.poll(preview, { timeout: 30_000 }).toBe(prompt)
      await openBoard()
      const session = (await fixture.find())!
      const card = page.locator(`[data-testid="session-card"][data-session-id="${session.id}"]:visible`).first()
      await expect(card.locator('.session-preview')).toHaveText(prompt)
      await expect(card).not.toContainText('[Image: original')
      await info.attach('correct-user-preview', { body: await page.screenshot(), contentType: 'image/png' })
      await openBoard()
      await expect(card.locator('.session-preview')).toHaveText(prompt)

      // Genuine image-only turns still replace the old prompt; a diagnostic
      // image snapshot cannot override that fallback or revive the sizing note.
      append(user([image]), snapshot([{ type: 'text', text: note }]), snapshot([image]))
      await expect.poll(preview, { timeout: 30_000 }).toBe('Image attached')
      await expect(card.locator('.session-preview')).toHaveText('Image attached')
      append(user('Continue after the image'))
      await expect.poll(preview, { timeout: 30_000 }).toBe('Continue after the image')
      await expect(card.locator('.session-preview')).toHaveText('Continue after the image')
    } finally {
      fixture.cleanup()
    }
  })
}
