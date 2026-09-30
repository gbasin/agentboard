import { test, expect } from '@playwright/test'

// Enough PRs that the chip row overflows into "+N" even in the full-width
// footer rail (~50px per pill), not just the narrow sidebar card.
const PRS = Array.from({ length: 30 }, (_, i) => ({
  url: `https://github.com/o/r/pull/${i + 1}`,
  repo: 'o/r',
  number: i + 1,
}))

const PR_LINK = 'a[href*="github.com/o/r/pull/"]'

// Inject prs into every 'sessions' payload so each session card renders a
// chip row that overflows. Exercises the real client render path (portal
// positioning, hover intent, nested cards) without faking log matching.
async function routeSessionsWithPrs(page: import('@playwright/test').Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      let out = message
      try {
        const parsed = JSON.parse(String(message))
        if (parsed.type === 'sessions' && Array.isArray(parsed.sessions)) {
          parsed.sessions = parsed.sessions.map(
            (s: Record<string, unknown>) => ({ ...s, prs: PRS })
          )
          out = JSON.stringify(parsed)
        }
      } catch {
        // non-JSON frame — forward as-is
      }
      ws.send(out)
    })
  })
}

test('hovering +N spills hidden PRs as a bare chip strip', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  await expect(card).toBeVisible()

  const more = card.getByRole('button', { name: /\d+ more PRs?$/ })
  await expect(more).toBeVisible()

  const visibleCount = await card.locator(PR_LINK).count()
  expect(visibleCount).toBeGreaterThan(0)
  expect(visibleCount).toBeLessThan(PRS.length)

  await more.hover()
  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()

  // The hidden PRs render as real chip links — one per folded PR.
  await expect(strip.locator(PR_LINK)).toHaveCount(PRS.length - visibleCount)

  // Bare strip: a wrapping pill cluster, no bordered-card chrome.
  const cls = await strip.getAttribute('class')
  expect(cls).toContain('flex-wrap')
  expect(cls).not.toContain('border')
  expect(cls).not.toContain('shadow')
  expect(cls).not.toContain('bg-elevated')

  // Clamped inside the viewport.
  const box = await strip.boundingBox()
  const vw = page.viewportSize()!.width
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw)
})

test('strip stays open while a spilled chip detail card is hovered', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  const more = card.getByRole('button', { name: /\d+ more PRs?$/ })
  await more.hover()
  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()

  // Rest on a spilled chip — its own hovercard opens.
  await strip.locator(PR_LINK).first().hover()
  const detailCard = page.getByTestId('pr-hovercard')
  await expect(detailCard).toBeVisible()

  // Moving onto that card crosses the strip boundary; past the close delay
  // the strip must still be open (nested card retains it).
  await detailCard.hover()
  await page.waitForTimeout(400)
  await expect(strip).toBeVisible()
  await expect(detailCard).toBeVisible()

  // Leaving everything closes card first, then the strip.
  await page.mouse.move(0, 0)
  await expect(detailCard).toBeHidden()
  await expect(strip).toBeHidden()
})

test('focusing +N opens the strip; tabbing away closes it', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  const more = card.getByRole('button', { name: /\d+ more PRs?$/ })
  await more.focus()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()

  await page.keyboard.press('Tab')
  await expect(strip).toBeHidden()
})

test('footer rail +N spills chips above the bar', async ({ page }) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  // Select the session so the rail renders its chip row.
  const card = page.getByTestId('session-card').first()
  await card.click()

  const rail = page.locator('footer')
  const more = rail.getByRole('button', { name: /\d+ more PRs?$/ })
  await expect(more).toBeVisible()
  await more.hover()

  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()
  await expect(strip.locator(PR_LINK).first()).toBeVisible()

  // The rail hugs the viewport bottom — the strip must flip above it.
  const s = await strip.boundingBox()
  const f = await rail.boundingBox()
  expect(s!.y + s!.height).toBeLessThanOrEqual(f!.y + 5)
})
