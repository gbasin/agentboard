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

type DrawerProbe = {
  __probe: {
    samples: {
      open: boolean
      top: number
      rel: number | null
      h: number
      inView: boolean
      selected: boolean
    }[]
    writes: { kind: string; frame: number; detail: string }[]
    done: boolean
  }
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
    // stays mounted off-screen), then instrument the open.
    //
    // Other specs run in parallel against the SAME tmux session and add/kill
    // windows at any moment. Those rows land above the selected one and move
    // it, and scroll anchoring does not reliably compensate while exiting rows
    // collapse and unmount (observed: 22 rows inserted, scrollTop unchanged,
    // rel +970px). Geometry sampled after the first open frame therefore says
    // nothing about the app — asserting it is what made this spec flaky. The
    // invariant is asserted on what churn cannot fake:
    //  1. landing: the selected row is in view on the FIRST visible frame;
    //  2. no snap: the app makes no programmatic scroll on the list (or
    //     scrollIntoView anywhere) after that frame. Each write records its
    //     args, the selected row and a stack: one unexplained late scrollTo
    //     (selection unchanged, row scrolled out of view) was seen once under
    //     a loaded 4-worker run — if this fires, that detail is the lead;
    //  3. no animated drift: while the list's content height is unchanged
    //     (no churn), the row's offset in the viewport stays put — this
    //     catches a smooth scroll started before open that keeps moving.
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
      const w = window as unknown as DrawerProbe
      w.__probe = { samples: [], writes: [], done: false }
      const probe = w.__probe
      const logWrite = (kind: string, args?: unknown) =>
        // samples.length is the index the next rAF sample will get, so a
        // write made in the open commit (before that frame) carries the
        // index of the first open sample.
        probe.writes.push({
          kind,
          frame: probe.samples.length,
          detail: JSON.stringify({
            args,
            selected: [...drawer.querySelectorAll<HTMLElement>('.session-row.selected')].map(
              (el) => el.dataset.sessionId
            ),
            stack: (new Error().stack ?? '').split('\n').slice(2, 7).join(' | '),
          }),
        })

      const proto = Object.getPrototypeOf(list) as HTMLElement
      const topDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
      Object.defineProperty(list, 'scrollTop', {
        configurable: true,
        get: () => topDesc.get!.call(list),
        set: (v: number) => {
          logWrite('scrollTop', v)
          topDesc.set!.call(list, v)
        },
      })
      for (const m of ['scrollTo', 'scroll', 'scrollBy'] as const) {
        const orig = proto[m]
        list[m] = function (this: HTMLElement, ...args: unknown[]) {
          logWrite(m, args)
          return (orig as (...a: unknown[]) => void).apply(this, args)
        } as typeof orig
      }
      const origIntoView = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
        if (list.contains(this)) logWrite('scrollIntoView')
        return origIntoView.call(this, arg)
      }

      const padTop = parseFloat(getComputedStyle(list).scrollPaddingTop) || 0
      let openFrames = 0
      const record = () => {
        const row = document.querySelector<HTMLElement>(rowSelector)
        const lr = list.getBoundingClientRect()
        const rr = row?.getBoundingClientRect()
        const open = drawer.classList.contains('open')
        probe.samples.push({
          open,
          top: list.scrollTop,
          rel: rr ? rr.top - lr.top : null,
          h: list.scrollHeight,
          inView: rr
            ? rr.top >= lr.top + padTop - 1 && rr.bottom <= lr.bottom + 1
            : false,
          selected: row?.classList.contains('selected') ?? false,
        })
        if (open) openFrames++
        // Sample a fixed number of OPEN frames (the 200ms transition and
        // beyond), however long the tap takes to land under CPU load.
        if (openFrames < 30 && probe.samples.length < 600) {
          requestAnimationFrame(record)
        } else {
          probe.done = true
        }
      }
      requestAnimationFrame(record)
    }, selectedId)

    await page.getByLabel('Open session menu').tap()
    await page.waitForFunction(
      () => (window as unknown as DrawerProbe).__probe.done,
      undefined,
      { timeout: 15000 }
    )
    const probe = await page.evaluate(
      () => (window as unknown as DrawerProbe).__probe
    )
    const diag = () => JSON.stringify(probe)

    const firstOpen = probe.samples.findIndex((s) => s.open)
    expect(firstOpen, `drawer never opened: ${diag()}`).toBeGreaterThanOrEqual(0)
    const first = probe.samples[firstOpen]

    // 1. Landing: positioned before the first visible frame.
    expect(first.selected, `selected row missing: ${diag()}`).toBe(true)
    expect(first.inView, `not in view on first open frame: ${diag()}`).toBe(true)
    // The scroll actually happened (not a degenerate no-op).
    expect(first.top, `no scroll happened: ${diag()}`).toBeGreaterThan(0)

    // 2. No snap: every programmatic scroll lands before the first open frame.
    // The landing scroll itself must have been seen, or the hooks are dead.
    expect(probe.writes.length, `no scroll write observed: ${diag()}`).toBeGreaterThan(0)
    const late = probe.writes.filter((w) => w.frame > firstOpen)
    expect(late, `scroll after first open frame: ${diag()}`).toEqual([])

    // 3. No drift while the content is unchanged.
    for (const s of probe.samples.slice(firstOpen)) {
      if (s.h !== first.h) continue
      expect(
        s.rel !== null && Math.abs(s.rel - first.rel!) <= 1,
        `row moved without a content change: ${JSON.stringify(s)}; ${diag()}`
      ).toBe(true)
    }
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
