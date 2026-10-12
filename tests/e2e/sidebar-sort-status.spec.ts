// E2E: the "Sort order: Status" setting pins permission sessions first and
// orders the rest by last activity — including under the Bottom anchor,
// where the mirrored list puts the pinned row next to the prompt — and a
// session the user just sent input to re-sorts immediately, not on the
// next pane-content refresh.
//
// Real `tail -f` panes cannot produce permission/waiting statuses on demand
// (status is derived from agent log events), so the harness injects
// status/lastActivity per window via `sessionOverrides`.
import { test, expect, type Locator } from '@playwright/test'
import {
  Windows,
  box,
  cardByName,
  desktopSidebar,
  installHarness,
  namesTopToBottom,
  uniquePrefix,
} from './helpers/sidebarHarness'

test.use({ serviceWorkers: 'block' })

const DISCOVERY = { timeout: 30_000 }
test.describe.configure({ timeout: 90_000 })

const windows = new Windows()
test.afterEach(() => windows.cleanup())

const BASE = Date.parse('2026-02-01T12:00:00.000Z')
const ago = (minutes: number) => new Date(BASE - minutes * 60_000).toISOString()

/**
 * Five windows with statuses and activity that disagree with both the
 * created-desc default and with pure recency:
 *
 *   00 working    3m ago   01 waiting    1m ago (newest)
 *   02 unknown    2m ago   03 permission 5m ago (oldest — pinning isn't recency)
 *   04 working    4m ago
 *
 * Status sort => [03] then [01, 02, 00, 04] by lastActivity desc.
 */
function statusOverrides() {
  return {
    0: { status: 'working', lastActivity: ago(3) },
    1: { status: 'waiting', lastActivity: ago(1) },
    2: { status: 'unknown', lastActivity: ago(2) },
    3: { status: 'permission', lastActivity: ago(5) },
    4: { status: 'working', lastActivity: ago(4) },
  }
}

function filterBar(scope: Locator): Locator {
  return scope
    .getByRole('button', { name: /^Filter\b/ })
    .locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " sticky ")][1]')
}

test('Status sort: permission pins first, the rest order by last activity', async ({
  page,
}) => {
  const prefix = uniquePrefix('sts')
  const names = windows.createMany(prefix, 5)
  await installHarness(page, {
    prefix,
    settings: { sessionSortMode: 'status' },
    sessionOverrides: statusOverrides(),
  })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(5, DISCOVERY)
  await expect
    .poll(() => namesTopToBottom(sidebar, prefix))
    .toEqual([names[3], names[1], names[2], names[0], names[4]])
})

test('Status sort under Bottom: the permission row sits lowest, next to the filter bar', async ({
  page,
}) => {
  const prefix = uniquePrefix('stb')
  const names = windows.createMany(prefix, 5)
  await installHarness(page, {
    prefix,
    settings: { sessionSortMode: 'status', sidebarAnchor: 'bottom' },
    sessionOverrides: statusOverrides(),
  })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(5, DISCOVERY)

  // Mirrored: the sorted-first row is the lowest on screen.
  await expect
    .poll(() => namesTopToBottom(sidebar, prefix))
    .toEqual([names[4], names[0], names[2], names[1], names[3]])

  // And it touches the filter bar — the "next to the prompt" position.
  const bar = await box(filterBar(sidebar))
  const pinned = await box(cardByName(sidebar, names[3]))
  expect(Math.abs(bar.top - pinned.bottom)).toBeLessThanOrEqual(1)
})

test('Status sort: pressing Enter moves the session to the top of the activity group', async ({
  page,
}) => {
  const prefix = uniquePrefix('stm')
  const names = windows.createMany(prefix, 5)

  // The tail -f pane's real lastActivity is ~its discovery time — newer than
  // every pinned value — so the row would start on top without a clamp, and
  // attach-time pane resizes keep bumping it server-side. Pin it stale on
  // every frame, and release only when a session-update reports activity
  // NEWER than the freshest sessions snapshot: the Enter keypress stamps
  // lastActivity=now inside the update itself, while a resize-bumped value
  // merely rides along on it at snapshot age.
  const STALE = '2020-01-01T00:00:00.000Z'
  let released = false
  let snapshotActivity = 0
  const overrides = {
    ...statusOverrides(),
    4: (session: Record<string, unknown>, frameType: string) => {
      const activity = Date.parse(String(session.lastActivity)) || 0
      if (frameType === 'sessions') {
        snapshotActivity = Math.max(snapshotActivity, activity)
      } else if (frameType === 'session-update' && activity > snapshotActivity) {
        released = true
      }
      return released ? {} : { lastActivity: STALE }
    },
  }

  await installHarness(page, {
    prefix,
    settings: { sessionSortMode: 'status' },
    sessionOverrides: overrides,
  })
  const sidebar = desktopSidebar(page)

  await page.goto('/')
  await expect(sidebar.getByTestId('session-card')).toHaveCount(5, DISCOVERY)
  await expect
    .poll(() => namesTopToBottom(sidebar, prefix))
    .toEqual([names[3], names[1], names[2], names[0], names[4]])

  // Attach the terminal and submit — the server stamps status=working and
  // lastActivity=now on the Enter keypress, so the row must move right away,
  // not after a pane-content refresh.
  await cardByName(sidebar, names[4]).click()
  await expect(page.locator('.xterm')).toBeVisible()
  await page.locator('.xterm-helper-textarea').focus()
  await page.waitForTimeout(1500) // let the attach settle so input is accepted
  await page.keyboard.press('Enter')

  await expect
    .poll(() => namesTopToBottom(sidebar, prefix))
    .toEqual([names[3], names[4], names[1], names[2], names[0]])
})
