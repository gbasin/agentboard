// E2E: on touch devices the card body pans the list natively while the drag
// handle starts a reorder. Before the fix, the dnd-kit activator sat on the
// whole row with no touch-action — the browser claimed vertical pans for
// native scrolling and fired pointercancel, so every touch drag died at
// activation (the card twitched, then snapped back).
//
// Touch drags go through CDP Input.dispatchTouchEvent — page.touchscreen only
// exposes tap(). The iPhone UA + hasTouch emulation makes pointer:coarse
// match, which is what moves the activator onto the handle.
import { test, expect, type CDPSession, type Page } from '@playwright/test'
import {
  Windows,
  cardByName,
  installHarness,
  namesTopToBottom,
  uniquePrefix,
} from './helpers/sidebarHarness'

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
})

const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

const drawer = '.session-drawer'

interface Point {
  x: number
  y: number
}

// CDP touch sequences are session-scoped — a second session can't lift a
// finger it never pressed — so the caller owns the session lifecycle.
async function touchStart(cdp: CDPSession, at: Point) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: at.x, y: at.y }],
  })
}

/** ~60Hz steps from `from` to `to`; one touchMove per frame so observers see each. */
async function touchMoveTo(cdp: CDPSession, page: Page, from: Point, to: Point, steps = 8) {
  for (let i = 1; i <= steps; i += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps },
      ],
    })
    await page.waitForTimeout(20)
  }
}

async function touchEnd(cdp: CDPSession) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function openDrawer(page: Page, cardCount: number) {
  await page.goto('/')
  await page.getByLabel('Open session menu').tap()
  await expect(page.locator(`${drawer}.open`)).toBeVisible()
  await expect(page.locator(`${drawer} [data-testid="session-card"]`)).toHaveCount(
    cardCount,
    DISCOVERY
  )
}

test('a vertical pan starting on the card body scrolls — it must not drag', async ({
  page,
}) => {
  const prefix = uniquePrefix('tpan')
  const names = windows.createMany(prefix, 24)
  await installHarness(page, { prefix })
  await openDrawer(page, 24)

  const scroller = page.locator(`${drawer} .overflow-y-auto`)
  // Give the gesture real runout and a known start.
  const overflow = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(overflow).toBeGreaterThan(200)
  await scroller.evaluate((el) => {
    el.scrollTop = 0
  })

  const card = cardByName(page.locator(drawer), names[0])
  const cardBox = await card.boundingBox()
  expect(cardBox).not.toBeNull()

  const cdp = await page.context().newCDPSession(page)
  try {
    await touchStart(cdp, {
      x: cardBox!.x + cardBox!.width / 2,
      y: cardBox!.y + cardBox!.height / 2,
    })
    await touchMoveTo(
      cdp,
      page,
      { x: cardBox!.x + cardBox!.width / 2, y: cardBox!.y + cardBox!.height / 2 },
      { x: cardBox!.x + cardBox!.width / 2, y: cardBox!.y + cardBox!.height / 2 - 260 }
    )
    await touchEnd(cdp)
  } finally {
    await cdp.detach()
  }

  // The gesture panned the list…
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(40)
  // …and the row never picked up a drag transform.
  const transform = await card.evaluate(
    (el) => el.parentElement?.style.transform ?? ''
  )
  expect(transform === '' || /translate3d\(0px, 0px/.test(transform)).toBe(true)
})

test('a pan starting on the drag handle drags and reorders the card', async ({
  page,
}) => {
  const prefix = uniquePrefix('tdrag')
  const names = windows.createMany(prefix, 4)
  await installHarness(page, { prefix })
  await openDrawer(page, 4)

  const drawerScope = page.locator(drawer)
  await expect.poll(() => namesTopToBottom(drawerScope, prefix)).toEqual(names)

  const card = cardByName(drawerScope, names[0])
  // The handle only exists on coarse pointers — its presence is itself the
  // fix surface.
  const handle = card.getByTestId('drag-handle')
  const handleBox = await handle.boundingBox()
  expect(handleBox).not.toBeNull()
  expect(await handle.evaluate((el) => getComputedStyle(el).touchAction)).toBe('none')

  const cdp = await page.context().newCDPSession(page)
  try {
    const from = { x: handleBox!.x + handleBox!.width / 2, y: handleBox!.y + handleBox!.height / 2 }
    // Drag two rows down and hold, so the mid-drag transform is observable.
    await touchStart(cdp, from)
    await touchMoveTo(cdp, page, from, { x: from.x, y: from.y + 96 })

    const midTransform = await card.evaluate(
      (el) => el.parentElement?.style.transform ?? ''
    )
    // Drag engaged and stayed engaged: nonzero y translate, x pinned.
    expect(midTransform).toMatch(/translate3d\(0px, [1-9][\d.]*px, 0px\)/)

    await touchEnd(cdp)
  } finally {
    await cdp.detach()
  }

  await expect
    .poll(() => namesTopToBottom(drawerScope, prefix))
    .not.toEqual(names)
})
