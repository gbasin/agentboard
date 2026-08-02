/**
 * Diagnose iOS terminal text-selection problems.
 *
 * On iOS the terminal canvas has no selectable text, so `screenReaderMode`
 * builds a DOM mirror (the xterm accessibility tree) which Terminal.tsx aligns
 * to the canvas grid. Native long-press selection acts on that mirror, so it
 * breaks in two ways, and this script measures both:
 *
 *   align  glyph advances in the DOM must track the canvas cell grid, or the
 *          highlight lands off the text it appears to cover
 *   churn  the mirror's row nodes must stay attached long enough for a
 *          ~500ms long-press to complete, or the gesture is aborted
 *
 * Run against a live instance (see scripts/ios-sim.sh for an isolated one):
 *   bun scripts/ios-a11y-diag.mjs align
 *   bun scripts/ios-a11y-diag.mjs churn
 *
 * Chromium is used deliberately: both properties are DOM/xterm level, not
 * engine specific, and headless WebKit cannot reproduce native iOS selection
 * anyway. Use scripts/ios-sim.sh for real gesture testing.
 */
import { chromium, devices } from '@playwright/test'

const URL = process.env.DIAG_URL || 'http://localhost:4055/'
const MODE = process.argv[2] || 'align'

async function openTerminal() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ ...devices['iPhone 13'], hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.route('**/sw.js', (r) => r.abort())
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.xterm-accessibility-tree', { timeout: 20000 })
  await page.waitForTimeout(3000)
  return { browser, page }
}

async function align(page) {
  return page.evaluate(() => {
    const screen = document.querySelector('.xterm-screen')
    const tree = document.querySelector('.xterm-accessibility-tree')
    if (!screen || !tree) return { error: 'terminal not ready' }

    const rect = screen.getBoundingClientRect()
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(200)
    probe.style.cssText =
      'position:absolute;visibility:hidden;white-space:pre;pointer-events:none;letter-spacing:0px'
    tree.appendChild(probe)
    const domCharW = probe.getBoundingClientRect().width / 200
    probe.remove()

    const letterSpacing = parseFloat(getComputedStyle(tree).letterSpacing) || 0
    const advance = domCharW + letterSpacing

    // Walk a Range across a long row and compare each character's DOM x to the
    // grid position the canvas drew it at.
    const rows = Array.from(tree.children)
    const row = rows
      .map((r) => ({ r, text: r.textContent || '' }))
      .filter((x) => x.text.trim().length > 40)
      .sort((a, b) => b.text.length - a.text.length)[0]

    let maxDriftPx = null
    if (row && row.r.firstChild) {
      const node = row.r.firstChild
      const range = document.createRange()
      const originRect = (() => {
        range.setStart(node, 0)
        range.setEnd(node, 1)
        return range.getBoundingClientRect()
      })()
      maxDriftPx = 0
      for (let col = 1; col < Math.min(row.text.length, 80); col++) {
        range.setStart(node, col)
        range.setEnd(node, col + 1)
        const got = range.getBoundingClientRect().left
        const want = originRect.left + col * advance
        maxDriftPx = Math.max(maxDriftPx, Math.abs(got - want))
      }
      maxDriftPx = +maxDriftPx.toFixed(3)
    }

    return {
      screenWidth: rect.width,
      domCharWidth: +domCharW.toFixed(3),
      letterSpacing: +letterSpacing.toFixed(3),
      // Terminal.tsx clamps the correction to +/-2px; at the clamp the DOM can
      // no longer be made to track the grid and the highlight visibly drifts.
      letterSpacingClamped: Math.abs(letterSpacing) >= 2,
      effectiveAdvance: +advance.toFixed(3),
      maxDriftPx,
      sampledRow: row ? row.text.slice(0, 50) : null,
    }
  })
}

async function churn(page, windowMs = 6000) {
  return page.evaluate(async (ms) => {
    const tree = document.querySelector('.xterm-accessibility-tree')
    if (!tree) return { error: 'no accessibility tree' }

    const events = []
    const obs = new MutationObserver((records) => {
      for (const r of records) events.push({ t: Math.round(performance.now()), type: r.type })
    })
    obs.observe(tree, { childList: true, subtree: true, characterData: true })

    // Hold a reference to the text node a finger would land on. iOS needs it to
    // stay attached for the whole gesture; if xterm replaces it the long-press
    // produces no selection at all.
    const anchor = Array.from(tree.children)
      .map((r) => r.firstChild)
      .find((n) => n && (n.textContent || '').trim().length > 10)
    const startedAttached = !!(anchor && anchor.isConnected)

    await new Promise((res) => setTimeout(res, ms))
    obs.disconnect()

    const times = events.map((e) => e.t).sort((a, b) => a - b)
    let longestQuietGapMs = ms
    if (times.length) {
      longestQuietGapMs = Math.max(times[0], ms - times[times.length - 1])
      for (let i = 1; i < times.length; i++) {
        longestQuietGapMs = Math.max(longestQuietGapMs, times[i] - times[i - 1])
      }
    }

    return {
      windowMs: ms,
      totalMutations: events.length,
      mutationsPerSecond: +(events.length / (ms / 1000)).toFixed(1),
      longestQuietGapMs,
      // A long-press needs roughly this much uninterrupted time to register.
      roomForLongPress: longestQuietGapMs >= 500,
      selectionAnchorSurvived: startedAttached && !!(anchor && anchor.isConnected),
    }
  }, windowMs)
}

const { browser, page } = await openTerminal()
try {
  const out = MODE === 'churn' ? await churn(page) : await align(page)
  console.log(JSON.stringify(out, null, 2))
} finally {
  await browser.close()
}
