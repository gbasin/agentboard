import { test, expect } from '@playwright/test'

// Enough PRs that the chip row overflows into "+N" even in the full-width
// footer rail (~50px per pill), not just the narrow sidebar card.
const PRS = Array.from({ length: 30 }, (_, i) => ({
  url: `https://github.com/o/r/pull/${i + 1}`,
  repo: 'o/r',
  number: i + 1,
}))

const PR_LINK = 'a[href*="github.com/o/r/pull/"]'

// The window tests/e2e/setup.ts creates for the whole run. Other specs share
// this server and create, update and kill their own windows while these
// tests hover; the stub hides those so the card under the pointer can't be
// re-sorted, replaced or killed mid-hover.
const PINNED_SESSION_NAME = 'test'

type WireSession = { name?: string; [k: string]: unknown }

// Show only the pinned session, with an overflowing PR list, in every frame
// that carries session objects: the 'sessions' snapshot and the incremental
// 'session-update' / 'session-created' frames. The client replaces a
// session wholesale on 'session-update', so a frame passed through
// unpatched would strip the PRs and unmount the chip row (and any open
// strip) under the pointer. Exercises the real client render path (portal
// positioning, hover intent, nested cards) without faking log matching.
async function routeSessionsWithPrs(page: import('@playwright/test').Page) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      let parsed: { type?: string; sessions?: WireSession[]; session?: WireSession }
      try {
        parsed = JSON.parse(String(message))
      } catch {
        ws.send(message) // non-JSON frame — forward as-is
        return
      }
      if (parsed.type === 'sessions' && Array.isArray(parsed.sessions)) {
        parsed.sessions = parsed.sessions
          .filter((s) => s.name === PINNED_SESSION_NAME)
          .map((s) => ({ ...s, prs: PRS }))
        ws.send(JSON.stringify(parsed))
        return
      }
      if (
        (parsed.type === 'session-update' ||
          parsed.type === 'session-created') &&
        parsed.session
      ) {
        if (parsed.session.name !== PINNED_SESSION_NAME) return
        parsed.session = { ...parsed.session, prs: PRS }
        ws.send(JSON.stringify(parsed))
        return
      }
      ws.send(message)
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

  // Tray strip: a wrapping pill cluster on an opaque recessed plate so
  // underlying text can't bleed through the gaps between pills.
  const cls = await strip.getAttribute('class')
  expect(cls).toContain('flex-wrap')
  expect(cls).toContain('border')
  expect(cls).toContain('shadow')
  expect(cls).toContain('bg-surface')
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

test('sweeping across spilled chips swaps detail cards without closing the strip', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  await card.getByRole('button', { name: /\d+ more PRs?$/ }).hover()
  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()

  const chips = strip.locator(PR_LINK)
  const secondHref = await chips.nth(1).getAttribute('href')

  // Rest on the first spilled chip — its detail card opens.
  await chips.first().hover()
  const detailCard = page.getByTestId('pr-hovercard')
  await expect(detailCard).toBeVisible()

  // Sweep to the neighbor: the first card closes, the second's opens —
  // exactly one card at a time, strip untouched throughout. The card's
  // first link identifies whose card it is (the card can link the same
  // PR twice once its detail loads, so don't match on href alone).
  await chips.nth(1).hover()
  await expect(detailCard).toHaveCount(1)
  await expect(detailCard.locator('a').first()).toHaveAttribute(
    'href',
    secondHref!
  )
  await page.waitForTimeout(400)
  await expect(strip).toBeVisible()
  await expect(detailCard).toHaveCount(1)
})

test('Enter opens the strip into its first chip; Escape returns focus to +N', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  const more = card.getByRole('button', { name: /\d+ more PRs?$/ })
  await more.focus()

  // Focus alone only highlights; Enter/ArrowDown opens.
  await expect(page.getByTestId('pr-flyout')).toBeHidden()
  await page.keyboard.press('Enter')
  const strip = page.getByTestId('pr-flyout')
  await expect(strip).toBeVisible()
  await expect(strip.locator(PR_LINK).first()).toBeFocused()
  // Enter belongs to "+N", not the card around it: selecting the session
  // would start a terminal attach that pulls focus out of the strip.
  await expect(card).not.toHaveClass(/\bselected\b/)

  // Escape closes the strip and returns focus to the +N button.
  await page.keyboard.press('Escape')
  await expect(strip).toBeHidden()
  await expect(more).toBeFocused()
})

test('Shift+Tab on the first chip returns focus to +N and closes', async ({
  page,
}) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  const card = page.getByTestId('session-card').first()
  const more = card.getByRole('button', { name: /\d+ more PRs?$/ })
  await more.focus()
  await page.keyboard.press('Enter')
  const strip = page.getByTestId('pr-flyout')
  await expect(strip.locator(PR_LINK).first()).toBeFocused()
  await expect(card).not.toHaveClass(/\bselected\b/)

  await page.keyboard.press('Shift+Tab')
  await expect(more).toBeFocused()
  await expect(strip).toBeHidden()
})

test('footer rail +N spills chips above the bar', async ({ page }) => {
  await routeSessionsWithPrs(page)
  await page.goto('/')

  // Select the session so the rail renders its chip row. Clicking also
  // scrolls the selection into view — a still-in-flight scroll event
  // would close a freshly opened strip, so settle before hovering.
  const card = page.getByTestId('session-card').first()
  await card.click()
  await expect(page.getByTestId('terminal-panel')).toBeVisible()
  await page.waitForTimeout(500)

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
