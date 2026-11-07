// Node owns Playwright's native browser pipes. The parent Bun process owns the fixture server.
import { chromium, webkit } from '@playwright/test'

const [name, origin] = process.argv.slice(2)
const browser = await { chromium, webkit }[name].launch({ headless: true })
const state = () => fetch(`${origin}/_verification/state`).then(response => response.json())
try {
  const page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('a[href="https://github.com/example/test/pull/1"]').hover()
  const deadline = Date.now() + 5_000
  let counts = await state()
  while ((!counts.infoRequests || !counts.checkRequests) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
    counts = await state()
  }
  if (counts.infoRequests !== 1 || counts.checkRequests !== 1) {
    throw Error(`Unbounded PR admission: ${counts.infoRequests} info, ${counts.checkRequests} checks`)
  }
  const started = performance.now()
  await page.getByTestId('media-rail-pill').click()
  // The gate stays closed until after the tile and WebSocket assertions.
  await page.getByTestId('media-chip').waitFor({ timeout: 5_000 })
  const firstTileMs = performance.now() - started
  await new Promise(resolve => setTimeout(resolve, 250))
  const pongs = await page.evaluate(() => window.pongs)
  counts = await state()
  const { infoRequests, checkRequests, mediaRequests, batches } = counts
  if (mediaRequests !== 1 || infoRequests !== 1 || checkRequests !== 1 || pongs !== 1 || batches.some(size => size > 8)) {
    throw Error('Media or WebSocket was blocked by optional metadata')
  }
  console.log(JSON.stringify({ engine: name, firstTileMs, heldInfo: infoRequests, heldChecks: checkRequests, mediaRequests, pongs }))
  await fetch(`${origin}/_verification/release`, { method: 'POST' })
  await page.getByRole('link', { name: 'example/test#18 Open', exact: true }).waitFor({ timeout: 5_000 })
  if ((await state()).batches.join(',') !== '8,8,2') throw Error(`Unexpected batches: ${(await state()).batches}`)
} finally { await browser.close() }
