// E2E: the mobile session drawer must open already scrolled to the selected
// row — the scroll is a layout effect while the drawer is still translated
// off-screen, so no frame of the open transition may show a stale position
// followed by a snap. (#298 deferred scrollIntoView behind a settle timer;
// the timer itself produced the visible snap this spec guards against.)
import { spawnSync } from 'node:child_process'
import { test, expect } from '@playwright/test'

test.use({
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
})

const WINDOW_PREFIX = 'scroll-test-'
const WINDOW_COUNT = 16

function tmux(args: string[]): { status: number | null } {
  const result = spawnSync('tmux', args, { encoding: 'utf-8' })
  return { status: result.status }
}

const drawerList = '.session-drawer .overflow-y-auto'
const drawerCard = '.session-drawer [data-testid="session-card"]'

test('drawer opens pre-positioned on the selected row — no mid-open snap', async ({
  page,
}) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')

  const created: string[] = []
  for (let i = 0; i < WINDOW_COUNT; i++) {
    const name = `${WINDOW_PREFIX}${i}`
    if (tmux(['new-window', '-t', session!, '-n', name]).status === 0) {
      created.push(name)
    }
  }

  try {
    await page.goto('/')

    // Enough rows that the drawer list overflows the 844px viewport.
    const cards = page.locator(drawerCard)
    await expect
      .poll(() => cards.count(), { timeout: 20000 })
      .toBeGreaterThanOrEqual(WINDOW_COUNT)

    // Open the drawer and select the LAST card in DOM order — deep enough
    // that "land on selection" must scroll.
    await page.getByLabel('Open session menu').tap()
    await expect(page.locator('.session-drawer.open')).toBeVisible()
    const lastCard = cards.last()
    const selectedId = await lastCard.getAttribute('data-session-id')
    await lastCard.tap()
    // Selecting a session closes the drawer.
    await expect(page.locator('.session-drawer.open')).toHaveCount(0)

    // Simulate a drifted scroll position while the drawer is closed (the list
    // stays mounted off-screen), then instrument per-frame sampling.
    await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>(
        '.session-drawer .overflow-y-auto'
      )!
      list.scrollTop = 0
      const drawer = document.querySelector('.session-drawer')!
      ;(window as unknown as { __samples: unknown[] }).__samples = []
      const record = () => {
        ;(window as unknown as { __samples: unknown[] }).__samples.push({
          open: drawer.classList.contains('open'),
          top: list.scrollTop,
        })
        if (
          (window as unknown as { __samples: unknown[] }).__samples.length < 60
        ) {
          requestAnimationFrame(record)
        }
      }
      requestAnimationFrame(record)
    })

    await page.getByLabel('Open session menu').tap()
    await page.waitForTimeout(700)

    const result = await page.evaluate((selId) => {
      const list = document.querySelector<HTMLElement>(
        '.session-drawer .overflow-y-auto'
      )!
      const sel = document.querySelector<HTMLElement>(
        `.session-drawer .session-row.selected[data-session-id="${selId}"]`
      )
      const padTop =
        parseFloat(getComputedStyle(list).scrollPaddingTop) || 0
      const lr = list.getBoundingClientRect()
      const sr = sel?.getBoundingClientRect()
      return {
        samples: (window as unknown as { __samples: { open: boolean; top: number }[] })
          .__samples,
        finalTop: list.scrollTop,
        selectedFound: !!sel,
        selectedInView: sr
          ? sr.top >= lr.top + padTop - 1 && sr.bottom <= lr.bottom + 1
          : false,
      }
    }, selectedId)

    const openSamples = result.samples.filter((s) => s.open)
    expect(openSamples.length).toBeGreaterThan(0)
    // Once the drawer is visible, scrollTop must already be at its final
    // value on EVERY frame — a post-landing snap would appear as a distinct
    // value mid-transition.
    for (const s of openSamples) {
      expect(s.top).toBe(result.finalTop)
    }
    // The scroll actually happened (not a degenerate no-op).
    expect(result.finalTop).toBeGreaterThan(0)
    expect(result.selectedFound).toBe(true)
    expect(result.selectedInView).toBe(true)
  } finally {
    for (const name of created) {
      tmux(['kill-window', '-t', `${session}:${name}`])
    }
  }
})

test('body scroll is locked while the drawer is open', async ({ page }) => {
  const session = process.env.E2E_TMUX_SESSION
  test.skip(!session, 'E2E_TMUX_SESSION not set')

  await page.goto('/')
  await page.getByLabel('Open session menu').tap()
  await expect(page.locator('.session-drawer.open')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.body.style.position))
    .toBe('fixed')

  await page.locator('.session-drawer-backdrop').tap({ position: { x: 350, y: 400 } })
  await expect(page.locator('.session-drawer.open')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => document.body.style.position))
    .toBe('')
})
