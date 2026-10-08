import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'

// The e2e webServer runs against AGENTBOARD_DB_PATH (a throwaway file in the
// suite's private tmpdir), so seeding board_sessions rows directly is safe.
// The catalog is noisy: other specs' windows dying lands here as interrupted
// rows, so assertions never assume a count — they check the notice against
// live health minus what the page has dismissed.
const dbPath = process.env.AGENTBOARD_DB_PATH
if (!dbPath) throw new Error('AGENTBOARD_DB_PATH is not set')
const base = `http://localhost:${process.env.E2E_PORT || 4173}`
const idPrefix = `e2e-notice-${process.pid}-${Date.now()}`
const DISMISSED_KEY = 'agentboard.recovery-notice.dismissed'

function sqlite(script: string) {
  const result = spawnSync('bun', ['-e', script], { encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(`sqlite failed: ${result.stderr}`)
}

function insertInterrupted(id: string) {
  sqlite(`import { Database } from 'bun:sqlite'
const db = new Database(${JSON.stringify(dbPath)})
const now = new Date().toISOString()
db.query("INSERT INTO board_sessions(id,name,project_path,host_id,command,state,pinned,created_at,last_activity_at,origin) VALUES(?,?,?,'e2e','echo hi','interrupted',0,?,?,'managed')").run(${JSON.stringify(id)}, ${JSON.stringify(id)}, '/tmp', now, now)
db.close()`)
}

// PATCH calls options.changed() on the server, broadcasting library-changed.
async function patchLibrary(id: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}/api/library/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(`PATCH /api/library/${id} failed: ${response.status}`)
}

// The notice's pending set is health.interruptedIds minus dismissed ids.
async function pendingCount(page: Page) {
  const dismissed = (await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? 'null'),
    DISMISSED_KEY
  )) as { ids?: string[] } | null
  const health = (await (
    await fetch(`${base}/api/library/health`)
  ).json()) as { interruptedIds?: string[] }
  const dismissedIds = new Set(dismissed?.ids ?? [])
  return (health.interruptedIds ?? []).filter((id) => !dismissedIds.has(id))
    .length
}

// Hidden iff no pending ids, else "<n> interrupted session(s) saved." — the
// poll retries until health, storage and the DOM agree.
async function expectNoticeConsistent(page: Page, notice: Locator) {
  await expect
    .poll(async () => {
      const pending = await pendingCount(page)
      const count = await notice.count()
      if (pending === 0) return count === 0
      if (count === 0) return false
      return (await notice.innerText()).startsWith(
        `${pending} interrupted session`
      )
    })
    .toBe(true)
}

test.afterEach(() => {
  // Delete our rows outright so leftovers can't count toward another spec's
  // notice while this server is shared.
  sqlite(`import { Database } from 'bun:sqlite'
const db = new Database(${JSON.stringify(dbPath)})
db.query("DELETE FROM board_sessions WHERE id LIKE '${idPrefix}-%'").run()
db.close()`)
})

test('recovery notice dismisses, persists, and clears on library-changed', async ({
  page,
}) => {
  const idA = `${idPrefix}-a`
  const idB = `${idPrefix}-b`
  const notice = page.getByTestId('recovery-notice')

  await page.goto('/')
  await expectNoticeConsistent(page, notice)

  // A new interruption surfaces the notice via library-changed, no reload.
  insertInterrupted(idA)
  await patchLibrary(idA, { name: 'still-stuck' })
  await expectNoticeConsistent(page, notice)
  await expect(notice).toBeVisible()

  // Dismiss covers every pending id; it stays hidden across reload.
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expectNoticeConsistent(page, notice)
  expect(await page.evaluate((k) => localStorage.getItem(k), DISMISSED_KEY))
    .toContain(idA)
  await page.reload()
  await expectNoticeConsistent(page, notice)

  // A different interrupted session re-shows the notice without a reload.
  insertInterrupted(idB)
  await patchLibrary(idA, { name: 'still-stuck-2' })
  await expectNoticeConsistent(page, notice)
  await expect(notice).toBeVisible()

  // Resolving the pending row clears the notice immediately rather than at
  // the next 60s poll.
  await patchLibrary(idB, { state: 'archived' })
  await expectNoticeConsistent(page, notice)
})
