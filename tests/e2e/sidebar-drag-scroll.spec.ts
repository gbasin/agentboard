// E2E: dragging a session card sideways must not scroll the panel horizontally,
// and the drag transform stays pixel-aligned.
//
// Before the fix, the dragged card's transform tracked the pointer on the x
// axis; once it passed the panel edge it grew the scroller's overflow area and
// dnd-kit's edge auto-scroll chased the pointer — scrollLeft ran past ~1900px
// and the whole card list slid off the panel. Fractional translate values also
// made the compositor resample the card's text, so it rendered blurry mid-drag.
import { test, expect } from '@playwright/test'
import {
  Windows,
  cardByName,
  desktopSidebar,
  installHarness,
  uniquePrefix,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

// New tmux windows reach the page on the server's next refresh tick. Waits are
// condition polls, so the generous budgets only cost time when slow.
const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

test('dragging a card sideways never scrolls the panel horizontally', async ({
  page,
}) => {
  const prefix = uniquePrefix('xdrag')
  const names = windows.createMany(prefix, 12)
  await installHarness(page, { prefix })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(12, DISCOVERY)

  const scroller = sidebar.locator('.overflow-y-auto')
  const card = cardByName(sidebar, names[0])
  const cardBox = await card.boundingBox()
  const sideBox = await sidebar.boundingBox()
  expect(cardBox).not.toBeNull()
  expect(sideBox).not.toBeNull()

  // Drag the first card down and far past the panel's right edge.
  await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2)
  await page.mouse.down()
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(
      cardBox!.x + cardBox!.width / 2 + step * 60,
      cardBox!.y + cardBox!.height / 2 + step * 15,
      { steps: 4 }
    )
  }

  // Prove the drag actually engaged — without this, containment asserts are
  // vacuous. The transform lives on the sortable wrapper (the card's parent).
  const midTransform = await card.evaluate(
    (el) => el.parentElement?.style.transform ?? ''
  )
  expect(midTransform).toMatch(/translate3d\(0px, [1-9][\d.]*px, 0px\)/)

  // Mid-drag: the scroller must never gain horizontal scrollability.
  const mid = await scroller.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(mid.scrollLeft).toBe(0)
  expect(mid.scrollWidth).toBe(mid.clientWidth)

  // The dragged card stays column-pinned inside the panel.
  const draggedBox = await card.boundingBox()
  expect(draggedBox).not.toBeNull()
  expect(draggedBox!.x).toBeGreaterThanOrEqual(sideBox!.x - 1)
  expect(draggedBox!.x + draggedBox!.width).toBeLessThanOrEqual(sideBox!.x + sideBox!.width + 1)

  await page.mouse.up()

  // Nothing changed underneath either after the drop settles.
  const after = await scroller.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(after.scrollLeft).toBe(0)
  expect(after.scrollWidth).toBe(after.clientWidth)
})
