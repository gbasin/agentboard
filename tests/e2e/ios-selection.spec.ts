// E2E: on iOS the terminal canvas has no selectable text, so long-press selects
// against xterm's accessibility-tree DOM mirror. xterm repaints that mirror by
// assigning `element.textContent` unconditionally, which destroys the Text node
// even when the string is identical and collapses any selection anchored to it.
// Measured against Claude Code in fullscreen, 97-100% of those rewrites wrote
// byte-identical text. keepA11yRowsStable() drops the no-op writes.
//
// The iOS code paths key off the user agent (isIOSDevice), so a desktop
// viewport with an iPhone UA exercises them without the mobile drawer.
import { test, expect } from '@playwright/test'

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 1280, height: 800 },
})

test('accessibility rows survive identical repaints without breaking updates', async ({
  page,
}) => {
  await page.goto('/')
  const card = page.getByTestId('session-card').first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.locator('.xterm')).toBeVisible()
  // The tree is built lazily once screenReaderMode initialises.
  await page.waitForSelector('.xterm-accessibility-tree > div', { timeout: 20000 })

  const result = await page.evaluate(() => {
    const tree = document.querySelector('.xterm-accessibility-tree')
    if (!tree) return { error: 'no accessibility tree' }
    const row = tree.firstElementChild as HTMLElement | null
    if (!row) return { error: 'no rows' }

    // Seed the row rather than relying on whatever the shell happened to
    // print. This is a genuine change, so it must create a Text node.
    const text = 'ALPHA selectable words here'
    row.textContent = text
    const node = row.firstChild as Text | null
    if (!node) return { error: 'seed write was swallowed' }

    // Anchor a real selection the way a long-press would.
    const range = document.createRange()
    range.setStart(node, 0)
    range.setEnd(node, 5)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    const selectedBefore = selection?.toString() ?? ''

    // Both writes AccessibilityManager makes, with the value unchanged.
    // innerText is the load-bearing case: browsers already collapse an
    // identical textContent write onto the existing node, but an identical
    // innerText write replaces it unconditionally, so without the guard this
    // is what destroys the selection anchor on xterm's blank rows.
    row.textContent = text
    row.innerText = text

    // posinset derives from buffer.ydisp, so it changes on scroll even when a
    // row's text does not. The guard must not swallow those attribute writes.
    row.setAttribute('aria-posinset', '4242')

    const afterNoop = {
      sameNode: row.firstChild === node,
      stillAttached: node.isConnected,
      selectedBefore,
      selectedAfter: window.getSelection()?.toString() ?? '',
      posinset: row.getAttribute('aria-posinset'),
    }

    // A row whose text genuinely changed must still repaint.
    row.textContent = 'BRAVO different text'

    return { ...afterNoop, changedText: row.textContent, error: undefined }
  })

  expect(result.error).toBeUndefined()
  expect(result.sameNode).toBe(true)
  expect(result.stillAttached).toBe(true)
  expect(result.selectedBefore).toBe('ALPHA')
  expect(result.selectedAfter).toBe('ALPHA')
  expect(result.posinset).toBe('4242')
  expect(result.changedText).toBe('BRAVO different text')
})
