// Message copy control in a real browser (copy-chat-message-markdown): the
// assistant row's Copy message button puts the reply's Markdown source on the
// clipboard (not the rendered text), is hidden until hover or focus without
// moving the row, always shows on touch devices, and still copies through the
// `copy`-event fallback when the page is not a secure context.
import { expect, test, type Page } from '@playwright/test'
import { killChat } from './support/chatHeader'

test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', 'Requires the development chat fixture')

// The development fixture's reply to "markdown" (src/server/chat/developmentFixture.ts).
const SHOWCASE = [
  '# Markdown showcase',
  '',
  'Headings, **bold**, *italic*, ~~struck through~~ and `inline code`, plus [a link](https://example.com).',
  '',
  '---',
  '',
  '## Lists',
  '',
  '- bullet one',
  '- bullet two',
  '',
  '1. first',
  '2. second',
  '',
  '- [ ] unchecked task',
  '- [x] done task',
  '',
  '## Table',
  '',
  '| Element | Rendered |',
  '| --- | --- |',
  '| table | bordered |',
  '| task list | checkboxes |',
  '',
  '> A blockquote sets text off.',
  '',
  '```ts',
  "const fenced = 'code block'",
  '```',
].join('\n')

async function createChat(page: Page, name: string) {
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Session kind').selectOption('chat')
  await dialog.getByLabel('Project Path').fill(process.cwd())
  await dialog.getByLabel('Display Name').fill(name)
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.getByTestId('chat-view')).toContainText(name)
}

/** Sends "markdown" and returns the assistant row holding the showcase. */
async function showcaseRow(page: Page) {
  await page.getByLabel('Message Claude').fill('markdown')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  const transcript = page.getByTestId('chat-transcript')
  await expect(transcript.getByRole('heading', { name: 'Markdown showcase' })).toBeVisible()
  await expect(transcript.getByText(/Turn complete/)).toBeVisible()
  return transcript.locator('[data-chat-role="assistant"]').filter({ has: page.getByRole('heading', { name: 'Markdown showcase' }) })
}

const readClipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText())

const grantClipboard = (page: Page) => page.context().grantPermissions(['clipboard-read', 'clipboard-write'])

// @covers: chat-sessions › Message copy control is accessible and unobtrusive › Pointer hover
// @covers: chat-sessions › Transcript messages can be copied as their original text › Assistant Markdown is copied as source
test('Copy message puts the Markdown source on the clipboard and reveals only on hover', async ({ page }, info) => {
  await grantClipboard(page)
  await createChat(page, 'Copy chat')
  const row = await showcaseRow(page)
  const button = row.getByRole('button', { name: 'Copy message' })

  await page.mouse.move(0, 0)
  await expect(button).toHaveCSS('opacity', '0')
  const before = await row.boundingBox()
  await row.hover()
  await expect(button).toHaveCSS('opacity', '1')
  expect(await row.boundingBox()).toEqual(before)
  await page.screenshot({ path: info.outputPath('copy-hover.png') })

  await button.click()
  await expect(button).toHaveAttribute('data-copy-state', 'copied')
  await expect(button.getByRole('status')).toHaveText('Copied')
  expect(await readClipboard(page)).toBe(SHOWCASE)
  // The rendered text differs (no `#`, `|`, or fences), so this is the source.
  expect(await row.locator('.chat-row-body').innerText()).not.toContain('# Markdown showcase')
  await expect(button).toHaveAttribute('data-copy-state', 'idle', { timeout: 4_000 })

  // A clicked button keeps focus (and so stays shown) until focus moves on.
  await expect(button).toHaveCSS('opacity', '1')
  await button.blur()
  await page.mouse.move(0, 0)
  await expect(button).toHaveCSS('opacity', '0')
  await killChat(page)
})

// @covers: chat-sessions › Message copy control is accessible and unobtrusive › Keyboard user
test('the control shows while it holds keyboard focus', async ({ page }) => {
  await grantClipboard(page)
  await createChat(page, 'Copy focus chat')
  const row = await showcaseRow(page)
  const button = row.getByRole('button', { name: 'Copy message' })
  await page.mouse.move(0, 0)
  await expect(button).toHaveCSS('opacity', '0')
  await button.focus()
  await expect(button).toBeFocused()
  await expect(button).toHaveCSS('opacity', '1')
  await page.keyboard.press('Enter')
  await expect(button.getByRole('status')).toHaveText('Copied')
  expect(await readClipboard(page)).toBe(SHOWCASE)
  await killChat(page)
})

// @covers: chat-sessions › Message copy reports its outcome › Insecure context
test('outside a secure context the copy-event fallback copies the same text', async ({ page }) => {
  await grantClipboard(page)
  await page.addInitScript(() => {
    // A plain-HTTP LAN address is not a secure context; the async API stays
    // reachable only so the test can read the clipboard back.
    Object.defineProperty(window, 'isSecureContext', { value: false })
    const execCommand = document.execCommand.bind(document)
    ;(window as unknown as { __copyCommands: number }).__copyCommands = 0
    document.execCommand = (command: string, ...rest: never[]) => {
      if (command === 'copy') (window as unknown as { __copyCommands: number }).__copyCommands += 1
      return execCommand(command, ...rest)
    }
  })
  await createChat(page, 'Copy fallback chat')
  const row = await showcaseRow(page)
  const button = row.getByRole('button', { name: 'Copy message' })
  await row.hover()
  await button.click()
  await expect(button.getByRole('status')).toHaveText('Copied')
  expect(await page.evaluate(() => (window as unknown as { __copyCommands: number }).__copyCommands)).toBe(1)
  expect(await readClipboard(page)).toBe(SHOWCASE)
  await killChat(page)
})

test.describe('touch device', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1280, height: 800 } })

  // @covers: chat-sessions › Message copy control is accessible and unobtrusive › Touch device
  test('on a touch device the control is visible without hover', async ({ page }) => {
    expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
    await createChat(page, 'Copy touch chat')
    const row = await showcaseRow(page)
    await expect(row.getByRole('button', { name: 'Copy message' })).toHaveCSS('opacity', '1')
    await killChat(page)
  })
})
