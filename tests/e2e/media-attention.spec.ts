/** Media arrival attention: live WS updates, finite motion, and acknowledgement. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  Windows, installHarness, uniquePrefix, desktopSidebar, cardByName,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block', reducedMotion: 'no-preference' })
test.describe.configure({ timeout: 60_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

const item = (id: string) => ({
  kind: 'link', url: `https://example.com/media/${id}`, label: `${id}.html`,
})
type Media = { kind: string; url: string; label: string }[]

async function board(page: Page, initial: Media = [], theme = 'dark') {
  const prefix = uniquePrefix('media')
  const names = windows.createMany(prefix, 2)
  const media: Media[] = [initial, [item('other-session')]]
  const harness = await installHarness(page, {
    prefix,
    settings: { theme },
    sessionOverrides: {
      0: () => ({ media: media[0] }),
      1: () => ({ media: media[1] }),
    },
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')
  const select = async (ordinal: number) => {
    const card = cardByName(desktopSidebar(page), names[ordinal])
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.click()
  }
  await select(0)
  return {
    select,
    update(next: Media) {
      media[0].splice(0, media[0].length, ...next)
      harness.pushSessions()
    },
    pill: page.getByTestId('media-rail-pill'),
    dot: page.getByTestId('media-rail-new-dot'),
  }
}

async function activeAnimation(pill: Locator) {
  return pill.evaluate((el) => el.getAnimations().some((a) =>
    a instanceof CSSAnimation && a.animationName === 'media-attention' && a.playState === 'running'
  ))
}

async function expectFinitePulse(pill: Locator) {
  await expect.poll(() => activeAnimation(pill)).toBe(true)
  const timing = await pill.evaluate((el) => {
    const animation = el.getAnimations().find((a) =>
      a instanceof CSSAnimation && a.animationName === 'media-attention' && a.playState === 'running'
    )!
    const timing = animation.effect!.getTiming()
    return { duration: Number(timing.duration), iterations: timing.iterations }
  })
  expect(timing.iterations).toBe(2)
  expect(timing.duration * timing.iterations).toBe(1600)
  await expect.poll(() => activeAnimation(pill), { timeout: 4000 }).toBe(false)
}

test('new batches pulse finitely, persist unread, and acknowledge on opening', async ({ page }) => {
  const { pill, dot, update } = await board(page)
  await expect(pill).toHaveCount(0)
  update([item('first')])
  await expect(pill).toBeVisible()
  await expect(pill).toHaveAccessibleName(/1 item.*new media/)
  await expect(dot).toBeVisible()
  await expectFinitePulse(pill)
  await expect(dot).toBeVisible()

  // Identical server refreshes must not restart attention.
  update([item('first')])
  await expect.poll(() => activeAnimation(pill)).toBe(false)
  await pill.click()
  const rail = page.getByTestId('media-rail')
  await expect(rail).toBeVisible()
  update([item('first'), item('while-open')])
  await expect(rail.getByRole('link')).toHaveCount(2)
  await rail.getByLabel('Collapse media rail').click()
  await expect(dot).toHaveCount(0)
  await expect.poll(() => activeAnimation(pill)).toBe(false)

  // Same count with a different URL is still a fresh media batch.
  update([item('first'), item('replacement')])
  await expect(dot).toBeVisible()
  await expectFinitePulse(pill)
  await pill.click()
  await rail.getByLabel('Collapse media rail').click()
  update([item('first'), item('replacement'), item('later')])
  await expect(dot).toBeVisible()
  await expectFinitePulse(pill)
})

test('initial history and switching sessions establish a quiet baseline', async ({ page }) => {
  const { pill, dot, select, update } = await board(page, [item('history')])
  await expect(pill).toBeVisible()
  await expect(dot).toHaveCount(0)
  expect(await activeAnimation(pill)).toBe(false)
  update([item('history'), item('new')])
  await expect(dot).toBeVisible()
  await select(1)
  await expect(pill).toHaveAccessibleName(/1 item/)
  await expect(dot).toHaveCount(0)
  expect(await activeAnimation(pill)).toBe(false)
  await select(0)
  await expect(pill).toHaveAccessibleName(/2 items/)
  await expect(dot).toHaveCount(0)
  expect(await activeAnimation(pill)).toBe(false)
})

test('reduced motion retains the static unread indicator without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const { pill, dot, update } = await board(page)
  update([item('reduced')])
  await expect(dot).toBeVisible()
  expect(await activeAnimation(pill)).toBe(false)
  await pill.click()
  await page.getByLabel('Collapse media rail').click()
  await expect(dot).toHaveCount(0)
})

for (const theme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    test.describe(`${theme} ${mobile ? 'mobile' : 'desktop'}`, () => {
      test.use({ hasTouch: mobile })
      test('media attention appearance', async ({ page }) => {
        const { pill, dot, update } = await board(page, [], theme)
        if (mobile) await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
        update([
          { kind: 'image', url: 'https://example.com/shot-one.png', label: 'Screenshot one' },
          { kind: 'image', url: 'https://example.com/shot-two.png', label: 'Screenshot two' },
          item('visual'),
        ])
        await expect(dot).toBeVisible()
        // Check the real animation before screenshots can finish or disable it.
        await expectFinitePulse(pill)
        const label = pill.getByText('Media', { exact: true })
        if (mobile) await expect(label).toBeHidden()
        else await expect(label).toBeVisible()
        const bounds = await pill.boundingBox()
        expect(bounds).not.toBeNull()
        if (mobile) {
          expect(bounds!.height).toBeGreaterThan(20)
          expect(bounds!.height).toBeLessThan(30)
          const touch = await pill.evaluate((el) => {
            const before = getComputedStyle(el, '::before')
            return {
              coarse: matchMedia('(pointer: coarse)').matches,
              width: parseFloat(before.width), height: parseFloat(before.height),
            }
          })
          expect(touch.coarse).toBe(true)
          expect(touch.width).toBeGreaterThanOrEqual(44)
          expect(touch.height).toBeGreaterThanOrEqual(44)
        } else expect(bounds!.height).toBeGreaterThanOrEqual(30)
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1280)
        await page.screenshot({
          path: `test-results/media-attention-${theme}-${mobile ? 'mobile' : 'desktop'}.png`,
        })
      })
    })
  }
}
