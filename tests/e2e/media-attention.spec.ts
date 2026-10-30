/** Media arrival attention: live WS updates, finite motion, and acknowledgement. */
import { test, expect, type Locator, type Page } from '@playwright/test'
import type { MediaSummary } from '../../src/shared/media'
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
type Media = { kind: string; url: string; label: string; bytes?: number; mediaType?: string; width?: number; height?: number }[]

async function board(page: Page, initial: Media = [], theme = 'dark') {
  const prefix = uniquePrefix('media')
  const names = windows.createMany(prefix, 2)
  const media: Media[] = [initial, [item('other-session')]]
  const ids = [crypto.randomUUID(), crypto.randomUUID()]
  const revisions = [0, 0], additions = [initial.length, 1]
  const summary = (i: number): MediaSummary => ({ identity: ids[i], revision: `${ids[i]}:${revisions[i]}`,
    total: media[i].length, images: media[i].filter(m => m.kind === 'image').length,
    documents: media[i].filter(m => m.kind === 'document').length,
    links: media[i].filter(m => m.kind === 'link').length, additions: additions[i] })
  const summaries = [summary(0), summary(1)]
  for (let i = 0; i < ids.length; i++) {
    await page.route(`**/api/session-media/${ids[i]}/items*`, route => {
      const kind = new URL(route.request().url()).searchParams.get('kind')
      const items = media[i].filter(item => kind === 'links' ? item.kind === 'link' : kind === 'media' ? item.kind !== 'link' : true)
      return route.fulfill({ json: {
        identity: ids[i], revision: summary(i).revision, total: items.length, items, nextCursor: null,
      } })
    })
  }
  const harness = await installHarness(page, {
    prefix,
    settings: { theme },
    sessionOverrides: {
      0: () => ({ agentSessionId: ids[0], mediaSummary: summaries[0] }),
      1: () => ({ agentSessionId: ids[1], mediaSummary: summaries[1] }),
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
      const seen = new Set(media[0].map(m => m.url))
      additions[0] += next.filter(m => !seen.has(m.url)).length
      if (JSON.stringify(next) !== JSON.stringify(media[0])) revisions[0]++
      media[0].splice(0, media[0].length, ...next)
      Object.assign(summaries[0], summary(0))
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
  await expect(pill).toBeVisible()
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
  await rail.getByRole('button', { name: 'Links 1', exact: true }).click()
  update([item('first'), item('while-open')])
  await expect(rail.getByRole('link')).toHaveCount(1)
  await page.getByRole('button', { name: 'Refresh media', exact: true }).click()
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
          path: test.info().outputPath(`media-attention-${theme}-${mobile ? 'mobile' : 'desktop'}.png`),
        })
      })
    })
  }
}

// Mixed payloads use the same tile geometry even when their labels are long.
const TILE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwnfwYAALcAbx8DLVyAAAAAElFTkSuQmCC'
const LONG_LINK = 'Preview deployment with a deliberately long descriptive artifact title'

for (const theme of ['light', 'dark']) {
  for (const mobile of [false, true]) {
    test.describe(`mixed media tiles ${theme} ${mobile ? 'mobile' : 'desktop'}`, () => {
      test.use({ hasTouch: mobile })
      test('equal tiles contain labels and scroll within the rail', async ({ page }) => {
        const oversizedUrl = 'https://example.com/oversized-preview.png'
        let oversizedRequests = 0
        await page.route(oversizedUrl, async (route) => {
          oversizedRequests++
          await route.abort()
        })
        const smallUrl = '/api/session-media/preview-fixture'
        await page.route(`**${smallUrl}?thumbnail=1`, route => route.fulfill({ contentType: 'image/png', body: Buffer.from(TILE_PNG_BASE64, 'base64') }))
        const { pill } = await board(page, [
          { kind: 'image', url: smallUrl, label: 'Small image', mediaType: 'image/png', bytes: Buffer.from(TILE_PNG_BASE64, 'base64').length, width: 1, height: 1 },
          { kind: 'link', url: 'https://example.com/artifact', label: LONG_LINK },
          { kind: 'document', url: 'https://example.com/requirements.pdf', label: 'Requirements and implementation notes.pdf', mediaType: 'application/pdf', bytes: 2048 },
          { kind: 'image', url: oversizedUrl, label: 'Large screenshot.png', mediaType: 'image/png', bytes: 13 * 1024 * 1024 },
          ...Array.from({ length: 5 }, (_, i) => ({ kind: 'document', url: `https://example.com/doc-${i}.pdf`, label: `Document ${i}` })),
        ], theme)
        if (mobile) await page.setViewportSize({ width: 390, height: 844 })
        await pill.click()
        const rail = page.getByTestId('media-rail')
        const tiles = rail.locator('[data-testid="media-thumb"], [data-testid="media-chip"], a')
        await expect(tiles).toHaveCount(8)
        for (const tile of await tiles.all()) {
          const bounds = await tile.boundingBox()
          expect(bounds!.width).toBe(56)
          expect(bounds!.height).toBe(56)
          const title = await tile.getAttribute('title')
          expect(title).toBeTruthy()
          await expect(tile).toHaveAccessibleName((await tile.getAttribute('aria-label')) ?? title!)
        }
        await expect(rail.getByRole('button', { name: 'Requirements and implementation notes.pdf · application/pdf · 2 KB', exact: true }))
          .toHaveAttribute('title', 'Requirements and implementation notes.pdf · application/pdf · 2 KB')
        await expect(rail.getByRole('button', { name: 'Large screenshot.png · image/png · 13.0 MB', exact: true }))
          .toHaveAttribute('title', 'Large screenshot.png · image/png · 13.0 MB')
        await expect.poll(() => rail.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1)
        expect(oversizedRequests).toBe(0)
        const strip = tiles.first().locator('..')
        const scroll = await strip.evaluate((el) => ({ client: el.clientWidth, total: el.scrollWidth }))
        expect(scroll.total).toBeGreaterThan(scroll.client)
        await strip.evaluate((el) => { el.scrollLeft = el.scrollWidth })
        await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
        const railBounds = await rail.boundingBox()
        expect(railBounds!.x).toBeGreaterThanOrEqual(0)
        expect(railBounds!.x + railBounds!.width).toBeLessThanOrEqual(mobile ? 390 : 1280)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await strip.evaluate((el) => { el.scrollLeft = 0 })
        const stem = test.info().outputPath(`media-tiles-${theme}-${mobile ? 'mobile' : 'desktop'}`)
        await rail.screenshot({ path: `${stem}-rail.png` })
        await page.screenshot({ path: `${stem}.png` })
        await rail.getByRole('button', { name: 'Links 1', exact: true }).click()
        const link = rail.getByRole('link', { name: LONG_LINK, exact: true })
        await expect(link).toHaveAttribute('href', 'https://example.com/artifact')
        await expect(link).toHaveAttribute('target', '_blank')
        await expect(link).toHaveAttribute('rel', /noopener/)
        await expect(rail.getByTestId('media-thumb')).toHaveCount(0)
      })
    })
  }
}
