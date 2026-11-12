import { expect, test } from '@playwright/test'
import { desktopSidebar, installHarness, uniquePrefix } from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' })

test('attention reorders and preview growth retain the bottom until the user scrolls away', async ({ page }, info) => {
  const prefix = uniquePrefix('pin')
  const harness = await installHarness(page, {
    prefix,
    settings: { sidebarAnchor: 'bottom', sessionSortMode: 'status', showLastUserMessage: true },
  })
  harness.extras.push(...Array.from({ length: 24 }, (_, i) => ({
    id: `syn-${prefix}-${i}`, name: `${prefix}-${i}`, tmuxWindow: `@syn-${i}`,
    projectPath: '/nonexistent/project', status: 'working', source: 'external',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    lastActivity: '2026-01-01T12:00:00.000Z', agentType: 'claude',
  })))
  await page.setViewportSize({ width: 1024, height: 600 })
  await page.goto('/')
  const sidebar = desktopSidebar(page)
  await expect(sidebar.getByTestId('session-card')).toHaveCount(24)
  const scroller = sidebar.locator('.overflow-y-auto').first()
  const gap = () => scroller.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
  // Initial auto-selection may intentionally reveal a different row.
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect.poll(gap).toBeLessThanOrEqual(2)
  const order = () => sidebar.getByTestId('session-card').evaluateAll(rows => rows.map(row => row.getAttribute('data-session-id')))
  for (const i of [8, 16, 3, 11, 0]) {
    const before = await order()
    harness.extras[i].status = 'permission'
    harness.pushSessions()
    await expect.poll(order).not.toEqual(before)
    await expect.poll(gap).toBeLessThanOrEqual(2)
  }
  harness.extras[11].lastUserMessage = 'A newly arrived prompt changes the height of this row.'
  harness.pushSessions()
  await expect(sidebar.locator(`[data-testid="session-card"][data-session-id="syn-${prefix}-11"]`)).toContainText('A newly arrived prompt')
  await expect.poll(gap).toBeLessThanOrEqual(2)
  await page.screenshot({ path: info.outputPath('bottom-after-attention-updates.png') })
  await scroller.hover()
  await scroller.evaluate(el => {
    el.addEventListener('scroll', () => el.setAttribute('data-user-scrolled', 'true'), { once: true })
  })
  await page.mouse.wheel(0, -300)
  await expect(scroller).toHaveAttribute('data-user-scrolled', 'true')
  await expect.poll(gap).toBeGreaterThan(100)
  const before = await order()
  harness.extras[5].status = 'permission'
  harness.pushSessions()
  await expect.poll(order).not.toEqual(before)
  await expect.poll(gap).toBeGreaterThan(100)
})
