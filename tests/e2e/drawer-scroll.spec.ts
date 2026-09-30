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

    // Enough rows that the drawer list overflows the 844px viewport. Card
    // heights vary (~44–68px depending on badges/messages), so a fixed count
    // can fit without scrolling — top up until the list really overflows by
    // more than a row, or "land on selection" is a no-op.
    const cards = page.locator(drawerCard)
    const listEl = page.locator(drawerList)
    await expect
      .poll(() => cards.count(), { timeout: 20000 })
      .toBeGreaterThanOrEqual(WINDOW_COUNT)
    let extras = 0
    await expect
      .poll(
        async () => {
          const overflow = await listEl.evaluate(
            (el) => el.scrollHeight - el.clientHeight
          )
          if (overflow < 120 && extras < 12) {
            const name = `${WINDOW_PREFIX}x${extras++}`
            if (tmux(['new-window', '-t', session!, '-n', name]).status === 0) {
              created.push(name)
            }
          }
          return overflow
        },
        { timeout: 20000 }
      )
      .toBeGreaterThanOrEqual(120)

    // Wait for the list to stop growing before measuring the open: tmux
    // windows stream in over WS discovery, and a late-arriving session inserts
    // at the top (createdAt-desc) — scroll anchoring then adjusts scrollTop
    // mid-transition, which reads identically to a post-landing snap here.
    const settleList = () =>
      expect
        .poll(
          async () => {
            const before = await listEl.evaluate((el) => el.scrollHeight)
            await page.waitForTimeout(300)
            const after = await listEl.evaluate((el) => el.scrollHeight)
            return before === after ? after : -1
          },
          { timeout: 15000 }
        )
        .not.toBe(-1)
    await settleList()

    // Open the drawer and select the LAST card in DOM order — deep enough
    // that "land on selection" must scroll.
    await page.getByLabel('Open session menu').tap()
    await expect(page.locator('.session-drawer.open')).toBeVisible()
    const lastCard = cards.last()
    const selectedId = await lastCard.getAttribute('data-session-id')
    await lastCard.tap()
    // Selecting a session closes the drawer.
    await expect(page.locator('.session-drawer.open')).toHaveCount(0)

    // Settle again: selection attaches the terminal and parallel specs keep
    // mutating the shared tmux session, so rows can still be arriving.
    await settleList()

    // Simulate a drifted scroll position while the drawer is closed (the list
    // stays mounted off-screen), then instrument per-frame sampling. `top`
    // (raw scrollTop) is recorded for diagnostics only — it can legitimately
    // shift mid-transition: rows other specs add/remove land above the
    // scrollport, and the browser's scroll anchoring adjusts scrollTop to
    // keep the visible rows stationary. The "no snap" invariant is `rel`:
    // the selected row's offset inside the list's viewport.
    await page.evaluate((selId) => {
      const list = document.querySelector<HTMLElement>(
        '.session-drawer .overflow-y-auto'
      )!
      list.scrollTop = 0
      const drawer = document.querySelector('.session-drawer')!
      // Scope to the drawer: the desktop sidebar renders an identical
      // .session-row for the same session and sits earlier in the DOM —
      // a document-wide query would sample its (hidden) rect instead.
      const rowSelector = `.session-drawer .session-row[data-session-id="${CSS.escape(selId)}"]`
      const w = window as unknown as {
        __samples: {
          open: boolean
          top: number
          rel: number | null
          h: number
        }[]
      }
      w.__samples = []
      const record = () => {
        const row = document.querySelector<HTMLElement>(rowSelector)
        w.__samples.push({
          open: drawer.classList.contains('open'),
          top: list.scrollTop,
          rel: row
            ? row.getBoundingClientRect().top -
              list.getBoundingClientRect().top
            : null,
          h: list.scrollHeight,
        })
        if (w.__samples.length < 60) {
          requestAnimationFrame(record)
        }
      }
      requestAnimationFrame(record)
    }, selectedId)

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
        samples: (window as unknown as {
          __samples: {
            open: boolean
            top: number
            rel: number | null
            h: number
          }[]
        }).__samples,
        finalTop: list.scrollTop,
        finalRel: sr ? sr.top - lr.top : null,
        selectedFound: !!sel,
        selectedInView: sr
          ? sr.top >= lr.top + padTop - 1 && sr.bottom <= lr.bottom + 1
          : false,
      }
    }, selectedId)

    const openSamples = result.samples.filter((s) => s.open)
    expect(openSamples.length).toBeGreaterThan(0)
    const firstRel = openSamples[0].rel
    expect(firstRel).not.toBeNull()
    // Once the drawer is visible, the selected row must already sit at its
    // landing position inside the viewport on EVERY sampled frame — a
    // post-landing snap shows up as a distinct rel mid-transition. scrollTop
    // itself may drift via scroll anchoring (see above) and is not asserted
    // per-frame. Compare against the first open frame rather than the final
    // eval: churn after the sampling window must not fail the assertion.
    for (const s of openSamples) {
      expect(
        s.rel !== null && Math.abs(s.rel - firstRel!) <= 1,
        `open-frame sample out of position: ${JSON.stringify(s)}; ` +
          `firstRel=${firstRel} finalTop=${result.finalTop} ` +
          `finalRel=${result.finalRel}; ` +
          `samples=${JSON.stringify(result.samples)}`
      ).toBe(true)
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
