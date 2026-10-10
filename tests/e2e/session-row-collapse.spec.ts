// E2E: a session card that re-enters while its exit collapse is mid-flight
// must not keep the half-collapsed pixel height. The exit animation writes an
// inline `height` on the sortable wrapper (which has overflow:hidden); if the
// exit is cancelled, a stale px height pins the row and clips any later content
// growth mid-glyph — e.g. the last-user message arriving on the next poll.
//
// The harness pushes synthetic `sessions` frames straight to the page, so the
// remove/re-add lands on an exact frame of the 200ms collapse instead of
// racing a server poll.
import { expect, test } from '@playwright/test'
import {
  cardByName,
  desktopSidebar,
  installHarness,
  uniquePrefix,
  windowName,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ timeout: 60_000 })

const LONG_MESSAGE =
  'please refactor the session row rendering to stop dropping the last user ' +
  'message when the list reorders mid animation and also make sure the badges ' +
  'stay aligned with the message text across all sidebar widths'

function syntheticSession(
  prefix: string,
  ordinal: number,
  overrides: Record<string, unknown> = {}
) {
  const name = windowName(prefix, ordinal)
  return {
    id: `syn-${name}`,
    name,
    tmuxWindow: `@syn-${ordinal}`,
    projectPath: '/nonexistent/project',
    status: 'waiting',
    lastActivity: '2026-01-01T12:00:00.000Z',
    createdAt: '2026-01-01T12:00:00.000Z',
    source: 'external',
    agentType: 'claude',
    ...overrides,
  }
}

test('card re-added mid exit-collapse does not clip a late-arriving message', async ({
  page,
}) => {
  const prefix = uniquePrefix('clip')
  const target = syntheticSession(prefix, 90)
  const other = syntheticSession(prefix, 91, { lastUserMessage: 'short note' })

  const harness = await installHarness(page, { prefix })
  harness.extras.push(target, other)
  await page.goto('/')

  const sidebar = desktopSidebar(page)
  const card = cardByName(sidebar, target.name)
  await expect(card).toBeVisible()

  const fullHeight = await card.evaluate((row) => row.parentElement!.clientHeight)

  // Drop the session: the exit collapse starts shrinking the wrapper.
  harness.extras.splice(0, harness.extras.length, other)
  harness.pushSessions()
  // Re-add it mid-collapse (kill rollback / flaky snapshot shape).
  await page.waitForTimeout(100)
  harness.extras.splice(0, harness.extras.length, target, other)
  harness.pushSessions()

  // Let the cancelled exit settle, then deliver the last-user message — the
  // row's content grows under whatever height the wrapper kept.
  await page.waitForTimeout(600)
  harness.extras.splice(
    0,
    harness.extras.length,
    { ...target, lastUserMessage: LONG_MESSAGE },
    other
  )
  harness.pushSessions()
  await expect(card.getByText(/refactor the session row/)).toBeVisible()

  const state = await card.evaluate((row) => {
    const wrap = row.parentElement!
    return {
      client: wrap.clientHeight,
      scroll: wrap.scrollHeight,
      style: wrap.getAttribute('style') ?? '',
    }
  })
  // The wrapper must track content, not a frozen px from the cancelled exit.
  expect(state.style).not.toMatch(/height:\s*[\d.]+px/)
  expect(state.client).toBeGreaterThan(fullHeight)
  expect(state.scroll).toBeLessThanOrEqual(state.client + 1)
})
