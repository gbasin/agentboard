/** Deterministic request races and multi-conversation controls in the real UI. */
import { test, expect } from '@playwright/test'
import type { SavedSession, HistoryDetail } from '../../src/shared/persistence'

const saved: SavedSession = {
  id: 'history-regression',
  name: 'Audit fixture',
  projectPath: '/fixture',
  hostId: 'test',
  agentType: 'codex',
  providerId: 'current',
  command: 'sh',
  state: 'hibernating',
  pinned: false,
  createdAt: '2020-01-01T00:00:00Z',
  lastActivityAt: '2020-01-01T00:00:00Z',
  window: null,
  epoch: null,
  error: null,
  preview: null,
  origin: 'managed',
  lastRunId: null,
}

test('changing filters invalidates an in-flight selection of all matching sessions', async ({
  page,
}) => {
  let oldRequests = 0
  let release!: () => void
  let started!: () => void
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const selecting = new Promise<void>((resolve) => {
    started = resolve
  })
  await page.route('**/api/library?*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')
    if (q === 'old' && ++oldRequests === 2) {
      started()
      await paused
    }
    await route.fulfill({
      json: {
        sessions: [{ ...saved, id: q || 'initial', name: q || 'Initial' }],
        nextCursor: null,
      },
    })
  })
  await page.goto('/')
  await page
    .getByRole('button', { name: 'History and recovery', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'History & recovery' })
  const search = dialog.getByRole('textbox', { name: 'Search saved sessions' })
  await search.fill('old')
  await expect(
    dialog.getByRole('button', { name: 'old', exact: true })
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Select all matching' }).click()
  await selecting
  await search.fill('new')
  await expect(
    dialog.getByRole('button', { name: 'new', exact: true })
  ).toBeVisible()
  release()
  await expect(
    dialog.getByRole('button', { name: 'Select all matching' })
  ).toBeEnabled()
  await expect(dialog.getByText('0 selected', { exact: true })).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'old', exact: true })
  ).toHaveCount(0)
})

test('conversation selection changes archive controls and preserves the loaded history page', async ({
  page,
}, testInfo) => {
  let listRequests = 0
  await page.route('**/api/library?*', async (route) => {
    listRequests++
    const cursor = new URL(route.request().url()).searchParams.get('cursor')
    await route.fulfill({
      json: {
        sessions: [cursor ? { ...saved, id: 'second', name: 'Second' } : saved],
        nextCursor: cursor ? null : 'page-2',
      },
    })
  })
  const detail: HistoryDetail = {
    session: saved,
    events: [],
    terminalPreview: null,
    terminalPreviewAt: null,
    conversations: ['current', 'older'].map((id) => ({
      sessionId: id,
      displayName: id,
      logFilePath: '/fixture/' + id,
      projectPath: '/fixture',
      agentType: 'codex',
      createdAt: saved.createdAt,
      lastActivityAt: saved.lastActivityAt,
      isActive: false,
      archive: {
        providerId: id,
        bytes: 30,
        updatedAt: saved.createdAt,
        complete: id === 'current',
        sourceMissing: true,
      },
    })),
  }
  await page.route('**/api/library/history-regression', (route) =>
    route.fulfill({ json: detail })
  )
  await page.route('**/api/session-preview/*?*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1)!
    return route.fulfill({
      json: {
        sessionId: id,
        displayName: id,
        projectPath: '/fixture',
        agentType: 'codex',
        lastActivityAt: saved.lastActivityAt,
        totalLines: 1,
        startLine: 1,
        endLine: 1,
        hasMoreBefore: false,
        lines: [
          JSON.stringify({
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: `Message from ${id} conversation` },
              ],
            },
          }),
        ],
      },
    })
  })
  await page.goto('/')
  await page
    .getByRole('button', { name: 'History and recovery', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'History & recovery' })
  await expect(dialog.getByTestId('saved-session')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Load more sessions' }).click()
  await expect(dialog.getByTestId('saved-session')).toHaveCount(2)
  const before = listRequests
  await dialog.getByRole('button', { name: saved.name, exact: true }).click()
  const download = dialog.getByRole('link', { name: 'Download conversation' })
  await expect(download).toHaveAttribute('href', /provider=current$/)
  await expect(
    dialog.getByRole('button', { name: 'Restore log and reopen' })
  ).toBeVisible()
  await dialog.getByLabel('Conversation log').selectOption('older')
  await expect(
    dialog.getByText('Message from older conversation', { exact: true })
  ).toBeVisible()
  await expect(download).toHaveAttribute('href', /provider=older$/)
  await expect(
    dialog.getByText('Partial log preview', { exact: false })
  ).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Restore log and reopen' })
  ).toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('older-conversation.png'),
    fullPage: true,
  })
  await dialog.getByRole('button', { name: 'Back to sessions' }).click()
  await expect(dialog.getByTestId('saved-session')).toHaveCount(2)
  expect(listRequests).toBe(before)
})
