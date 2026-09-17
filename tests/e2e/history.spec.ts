/** Exercise durable History UI against the isolated Playwright server. */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test('search, page, rename and group year-old sessions, then download a backup', async ({
  page,
  request,
}, testInfo) => {
  const dir = path.join(process.env.CODEX_HOME!, 'sessions', '2020', '01', '01')
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 65; i++) {
    const id = `history-e2e-${i}`
    const lines = [
      {
        type: 'session_meta',
        timestamp: '2020-01-01T00:00:00.000Z',
        payload: { id, cwd: `/history-fixture/project-${i}`, source: 'cli' },
      },
      {
        type: 'response_item',
        timestamp: '2020-01-01T01:00:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Historical task ${i}` }],
        },
      },
    ]
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
  }
  await expect
    .poll(async () => {
      await request.post('/api/library/reindex')
      const response = await request.get(
        '/api/library?q=history-fixture&limit=100'
      )
      return (await response.json()).sessions.length
    })
    .toBe(65)
  await page.goto('/')
  await page
    .getByRole('button', { name: 'History and recovery', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'History & recovery' })
  await expect(dialog).toBeVisible()
  await dialog
    .getByRole('textbox', { name: 'Search saved sessions' })
    .fill('history-fixture')
  await expect(dialog.getByTestId('saved-session')).toHaveCount(50)
  await dialog.getByRole('button', { name: 'Load more sessions' }).click()
  await expect(dialog.getByTestId('saved-session')).toHaveCount(65)
  await dialog.getByLabel('History period').selectOption('24')
  await expect(
    dialog.getByText('No saved sessions match these filters.')
  ).toBeVisible()
  await dialog.getByLabel('History period').selectOption('0')
  await expect(dialog.getByTestId('saved-session')).toHaveCount(50)
  const first = dialog.getByTestId('saved-session').first()
  await first.getByRole('button', { name: 'Rename', exact: true }).click()
  await first
    .getByRole('textbox', { name: 'Session name', exact: true })
    .fill('A-Persistent-History')
  await first.getByRole('button', { name: 'Save name' }).click()
  await expect(
    dialog.getByRole('button', { name: 'A-Persistent-History', exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Select all matching' }).click()
  await expect(dialog.getByText('65 selected', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save as workspace' }).click()
  await dialog
    .getByRole('textbox', { name: 'Workspace name' })
    .fill('Historical team')
  await dialog
    .getByRole('button', { name: 'Save 65 selected sessions' })
    .click()
  await expect(
    dialog.getByRole('heading', { name: 'Historical team' })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Sessions', exact: true }).click()
  await dialog
    .getByRole('textbox', { name: 'Search saved sessions' })
    .fill('A-Persistent-History')
  await expect(dialog.getByTestId('saved-session')).toHaveCount(1)
  await page.screenshot({
    path: testInfo.outputPath('history-desktop.png'),
    fullPage: true,
  })
  await dialog
    .getByRole('button', { name: 'Storage & backups', exact: true })
    .click()
  await dialog.getByRole('button', { name: 'Back up now', exact: true }).click()
  await expect(
    dialog.getByRole('link', { name: 'Download', exact: true }).first()
  ).toBeVisible()
  const downloaded = page.waitForEvent('download')
  await dialog
    .getByRole('link', { name: 'Download', exact: true })
    .first()
    .click()
  expect((await downloaded).suggestedFilename()).toMatch(/\.db$/)
  await dialog.getByRole('button', { name: 'Close history' }).click()
  await expect(dialog).not.toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page
    .getByRole('button', { name: 'History & recovery', exact: true })
    .click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(
    dialog.getByRole('button', { name: 'A-Persistent-History', exact: true })
  ).toBeVisible()
  const overflow = await dialog.evaluate(
    (el) => el.scrollWidth > el.clientWidth
  )
  expect(overflow).toBe(false)
  await page.screenshot({
    path: testInfo.outputPath('history-mobile.png'),
    fullPage: true,
  })
})
