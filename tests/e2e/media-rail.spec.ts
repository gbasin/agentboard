import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { crc32, deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { tmuxSession } from './helpers/sidebarHarness'

// End-to-end coverage for the media rail: real Claude + Codex logs seeded
// into the suite's isolated log dirs are discovered by the real LogPoller,
// scanned by mediaExtractor, and served back through /api/session-media —
// nothing on the server path is stubbed. The rail UI is driven by injecting
// the seeded descriptors onto the shared 'test' window's session frames
// (the pr-chips.spec.ts pattern), so the client render path is real too.

test.describe.configure({ timeout: 120_000 })

const PINNED_SESSION_NAME = 'test'

// 96x48 two-tone PNG built for this spec.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAYAAADuFn/PAAAA00lEQVR4nO3XQRHDQBADQUMJBEMJxMDy00xsGJIq/RCB2brT6Dh/97Oc6/OdzpEG6AAFEL2AApC+oNGk/3AdUABRCReAZEGjoaEOoITjJsOCCkDS0AKYdsBg0iXKggog0tACkHbAaAwxB1DCcZNhQQUgaWgBTDtgMOkSZUEFEGloAUg7YDSGmAMo4bjJsKACkDS0AKYdMJh0ibKgAog0tACkHTAaQ8wBlHDcZFhQAUgaWgDTDhhMukRZUAFEGloA0g4YjSHmAEo4bjIsqADk+aca+gJtWqiVzVBm3gAAAABJRU5ErkJggg=='
const PNG_LEN = Buffer.from(PNG_B64, 'base64').length

// A bigger generated PNG — ~1-4 MB compressed depending on w/h — so the spec
// exercises the multi-MB line path, not just thumbnail-sized payloads.
function makePng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 4)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const o = row + 1 + x * 4
      const v = (x * 31 + y * 17) & 0xff
      raw[o] = v
      raw[o + 1] = (v * 3) & 0xff
      raw[o + 2] = 255 - v
      raw[o + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

interface Seeded {
  sessionId: string
  logPath: string
  /** Byte offset of the line holding the first image payload. */
  imageOffset: number
}

function writeJsonl(lines: string[]): { offsets: number[]; body: string } {
  const offsets: number[] = []
  let body = ''
  for (const line of lines) {
    offsets.push(Buffer.byteLength(body))
    body += line + '\n'
  }
  return { offsets, body }
}

function seedClaudeMediaLog(tag: string): Seeded {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR
  if (!claudeDir) throw new Error('CLAUDE_CONFIG_DIR is not set')
  const projectDir = path.join(claudeDir, 'projects', `-tmp-ab-e2e-media-${tag}`)
  fs.mkdirSync(projectDir, { recursive: true })

  const sessionId = randomUUID()
  const ts = new Date().toISOString()
  const cwd = `/tmp/ab-e2e-media-${tag}`
  const { offsets, body } = writeJsonl([
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd,
      timestamp: ts,
      message: { role: 'user', content: `media e2e ${tag}` },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: ts,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_e2e_1',
            name: 'Read',
            input: { file_path: `${cwd}/shot.png` },
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd,
      timestamp: ts,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_e2e_1',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
              },
            ],
          },
        ],
      },
      toolUseResult: {
        type: 'image',
        file: {
          type: 'image/png',
          originalSize: PNG_LEN,
          dimensions: { originalWidth: 96, originalHeight: 48 },
        },
      },
    }),
    JSON.stringify({
      type: 'frame-link',
      sessionId,
      timestamp: ts,
      frameUrl: 'https://claude.ai/artifact/e2eartifact',
      title: 'E2E audit board',
      path: `${cwd}/index.html`,
    }),
  ])

  const logPath = path.join(projectDir, `${sessionId}.jsonl`)
  fs.writeFileSync(logPath, body)
  return { sessionId, logPath, imageOffset: offsets[2] }
}

function seedCodexMediaLog(tag: string): Seeded {
  const codexHome = process.env.CODEX_HOME
  if (!codexHome) throw new Error('CODEX_HOME is not set')
  const now = new Date()
  const dir = path.join(
    codexHome,
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0')
  )
  fs.mkdirSync(dir, { recursive: true })

  const sessionId = randomUUID()
  const ts = now.toISOString()
  const cwd = `/tmp/ab-e2e-media-${tag}`
  const { offsets, body } = writeJsonl([
    JSON.stringify({
      type: 'session_meta',
      timestamp: ts,
      payload: { id: sessionId, timestamp: ts, cwd, source: 'cli' },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `codex media ${tag}` }],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      timestamp: ts,
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: `data:image/png;base64,${PNG_B64}`,
          },
        ],
      },
    }),
  ])

  const logPath = path.join(
    dir,
    `rollout-${ts.replace(/[:.]/g, '-')}-${sessionId}.jsonl`
  )
  fs.writeFileSync(logPath, body)
  return { sessionId, logPath, imageOffset: offsets[2] }
}

function mediaUrl(seeded: Seeded, index = 0): string {
  return (
    `/api/session-media/${seeded.sessionId}` +
    `?path=${encodeURIComponent(seeded.logPath)}` +
    `&offset=${seeded.imageOffset}&index=${index}&bytes=${PNG_LEN}`
  )
}

// Discovery is one LogPoller cycle; poll the endpoint until the record lands.
async function waitForMedia(
  request: import('@playwright/test').APIRequestContext,
  seeded: Seeded
) {
  await expect
    .poll(
      async () => (await request.get(mediaUrl(seeded))).status(),
      { timeout: 60_000, intervals: [1000, 2000, 5000] }
    )
    .toBe(200)
}

type WireSession = { name?: string; media?: unknown[]; [k: string]: unknown }

// Patch the pinned window session's frames to carry the seeded descriptors —
// same WS interception pattern as pr-chips.spec.ts. The rail renders the real
// component against real endpoint URLs.
async function routeSessionsWithMedia(
  page: import('@playwright/test').Page,
  media: unknown[]
) {
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => {
      let parsed: { type?: string; sessions?: WireSession[]; session?: WireSession }
      try {
        parsed = JSON.parse(String(message))
      } catch {
        ws.send(message)
        return
      }
      if (parsed.type === 'sessions' && Array.isArray(parsed.sessions)) {
        parsed.sessions = parsed.sessions.map((s) =>
          s.name === PINNED_SESSION_NAME ? { ...s, media } : s
        )
        ws.send(JSON.stringify(parsed))
        return
      }
      if (
        (parsed.type === 'session-update' || parsed.type === 'session-created') &&
        parsed.session?.name === PINNED_SESSION_NAME
      ) {
        parsed.session = { ...parsed.session, media }
        ws.send(JSON.stringify(parsed))
        return
      }
      ws.send(message)
    })
  })
}

test('session-media endpoint serves seeded claude and codex payloads', async ({
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const claude = seedClaudeMediaLog(tag)
  const codex = seedCodexMediaLog(tag)

  await waitForMedia(request, claude)
  await waitForMedia(request, codex)

  for (const seeded of [claude, codex]) {
    const res = await request.get(mediaUrl(seeded))
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toBe('image/png')
    expect(Buffer.compare(await res.body(), Buffer.from(PNG_B64, 'base64'))).toBe(0)
  }

  // Path must belong to the session; index must exist at the offset.
  expect(
    (await request.get(`/api/session-media/${claude.sessionId}?path=/etc/hosts&offset=0&index=0`)).status()
  ).toBe(400)
  expect(
    (await request.get(mediaUrl(claude, 9))).status()
  ).toBe(404)
})

function claudeDocSeed(tag: string): { sessionId: string; logPath: string; docOffset: number } {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR
  if (!claudeDir) throw new Error('CLAUDE_CONFIG_DIR is not set')
  const projectDir = path.join(claudeDir, 'projects', `-tmp-ab-e2e-doc-${tag}`)
  fs.mkdirSync(projectDir, { recursive: true })
  const sessionId = randomUUID()
  const ts = new Date().toISOString()
  const pdfB64 = Buffer.from('%PDF-1.4 e2e fake pdf body').toString('base64')
  const { offsets, body } = writeJsonl([
    JSON.stringify({
      type: 'user',
      sessionId,
      cwd: `/tmp/ab-e2e-doc-${tag}`,
      timestamp: ts,
      message: { role: 'user', content: `doc e2e ${tag}` },
    }),
    JSON.stringify({
      type: 'user',
      sessionId,
      timestamp: ts,
      message: {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: pdfB64,
            },
          },
        ],
      },
    }),
  ])
  const logPath = path.join(projectDir, `${sessionId}.jsonl`)
  fs.writeFileSync(logPath, body)
  return { sessionId, logPath, docOffset: offsets[1] }
}

function docUrl(seeded: { sessionId: string; logPath: string; docOffset: number }) {
  return (
    `/api/session-media/${seeded.sessionId}` +
    `?path=${encodeURIComponent(seeded.logPath)}&offset=${seeded.docOffset}&index=0`
  )
}

test('document payloads become chips that open the served bytes', async ({
  page,
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const doc = claudeDocSeed(tag)

  // Wait for discovery via the endpoint, then verify the PDF bytes directly.
  await expect
    .poll(
      async () => (await request.get(docUrl(doc))).status(),
      { timeout: 60_000, intervals: [1000, 2000, 5000] }
    )
    .toBe(200)
  const res = await request.get(docUrl(doc))
  expect(res.headers()['content-type']).toBe('application/pdf')
  expect((await res.body()).toString()).toBe('%PDF-1.4 e2e fake pdf body')

  await routeSessionsWithMedia(page, [
    {
      kind: 'document',
      url: docUrl(doc),
      mediaType: 'application/pdf',
      bytes: 24,
      label: 'spec.pdf',
    },
  ])
  await page.goto('/')
  const card = page.getByTestId('session-card').filter({ hasText: PINNED_SESSION_NAME }).first()
  await card.click()

  await page.getByTestId('media-rail-pill').click()
  const chip = page.getByTestId('media-chip')
  await expect(chip).toBeVisible()
  // The chip opens the endpoint URL in a new tab — stub window.open to
  // observe the target without depending on the browser's PDF handling.
  await page.evaluate(() => {
    const w = window as unknown as { __opened?: string[]; open: unknown }
    w.__opened = []
    w.open = (u: unknown) => {
      w.__opened!.push(String(u))
      return null
    }
  })
  await chip.click()
  const opened = await page.evaluate(
    () => (window as unknown as { __opened: string[] }).__opened
  )
  expect(opened).toEqual([docUrl(doc)])
})

test('media appended to a live log gets served at the new offset', async ({
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const claude = seedClaudeMediaLog(tag)
  await waitForMedia(request, claude)

  // A ~2 MB image lands mid-session: appended line → incremental scan →
  // the endpoint serves it at the new byte offset.
  const big = makePng(1200, 800)
  const newOffset = fs.statSync(claude.logPath).size
  const bigLine = JSON.stringify({
    type: 'user',
    sessionId: claude.sessionId,
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: big.toString('base64'),
          },
        },
      ],
    },
  })
  fs.appendFileSync(claude.logPath, bigLine + '\n')

  const bigUrl =
    `/api/session-media/${claude.sessionId}` +
    `?path=${encodeURIComponent(claude.logPath)}&offset=${newOffset}&index=0&bytes=${big.length}`
  await expect
    .poll(
      async () => (await request.get(bigUrl)).status(),
      { timeout: 60_000, intervals: [1000, 2000, 5000] }
    )
    .toBe(200)
  const res = await request.get(bigUrl)
  expect(res.headers()['content-type']).toBe('image/png')
  expect((await res.body()).length).toBe(big.length)
})

test('media arriving mid-session surfaces the rail without a reload', async ({
  page,
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const claude = seedClaudeMediaLog(tag)
  await waitForMedia(request, claude)

  const media = [
    {
      kind: 'image',
      url: mediaUrl(claude),
      mediaType: 'image/png',
      bytes: PNG_LEN,
      label: 'late.png',
    },
  ]

  // Pass frames through untouched until armed; once armed, every broadcast
  // carries media — the shape of a real session update stream. A single
  // injected frame would race the next real broadcast and lose.
  let armed = false
  let lastSessions: string | null = null
  let pushMedia: () => void = () => {}
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    pushMedia = () => {
      if (!lastSessions) return
      const parsed = JSON.parse(lastSessions) as { sessions: WireSession[] }
      parsed.sessions = parsed.sessions.map((s) =>
        s.name === PINNED_SESSION_NAME ? { ...s, media } : s
      )
      ws.send(JSON.stringify(parsed))
    }
    server.onMessage((m) => {
      let parsed: { type?: string; sessions?: WireSession[]; session?: WireSession }
      try {
        parsed = JSON.parse(String(m))
      } catch {
        ws.send(m)
        return
      }
      if (parsed.type === 'sessions' && Array.isArray(parsed.sessions)) {
        lastSessions = String(m)
        if (armed) {
          parsed.sessions = parsed.sessions.map((s) =>
            s.name === PINNED_SESSION_NAME ? { ...s, media } : s
          )
          ws.send(JSON.stringify(parsed))
          return
        }
      }
      if (
        armed &&
        (parsed.type === 'session-update' || parsed.type === 'session-created') &&
        parsed.session?.name === PINNED_SESSION_NAME
      ) {
        parsed.session = { ...parsed.session, media }
        ws.send(JSON.stringify(parsed))
        return
      }
      ws.send(m)
    })
  })
  await page.goto('/')

  const card = page.getByTestId('session-card').filter({ hasText: PINNED_SESSION_NAME }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()
  // No media yet — the rail stays hidden.
  await expect(page.getByTestId('media-rail-pill')).toHaveCount(0)

  // Broadcasts start carrying media; the pill mounts without a reload. Push
  // immediately (broadcasts are change-driven, not periodic) and let arming
  // keep the media on every real frame after.
  armed = true
  pushMedia()
  await expect(page.getByTestId('media-rail-pill')).toBeVisible({ timeout: 30_000 })
})

test('a real window matched to a seeded claude log gets the rail', async ({
  page,
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const marker = `media e2e ${tag}`
  const projectDir = `/tmp/ab-e2e-media-${tag}`
  fs.mkdirSync(projectDir, { recursive: true })

  // Create the window BEFORE the log: its pane carries the marker as a
  // submitted Claude prompt line (the matcher only reads ❯ prompt text; ⏺
  // marks it submitted rather than the live input row). Seeding after the
  // window is registered means the match lands at insert time instead of
  // needing a growth-triggered orphan rematch (cooldown: one/minute).
  const windowName = `mwin-${tag}`
  const created = spawnSync(
    'tmux',
    [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}',
      '-t',
      `${tmuxSession()}:`,
      '-n',
      windowName,
      '-c',
      projectDir,
      `echo "❯ ${marker}"; echo "⏺ ack"; tail -f /dev/null`,
    ],
    { encoding: 'utf-8' }
  )
  if (created.status !== 0) throw new Error(`tmux new-window: ${created.stderr}`)
  const windowId = created.stdout.trim()

  const pollSessions = async () => {
    const res = await request.get('/api/sessions')
    const sessions = (await res.json()) as Array<{
      name?: string
      media?: unknown[]
    }>
    return sessions.find((s) => s.name === windowName)
  }

  try {
    // Wait for the window to enter the registry before seeding the log.
    await expect
      .poll(async () => Boolean(await pollSessions()), {
        timeout: 30_000,
        intervals: [1000, 2000],
      })
      .toBe(true)

    const seeded = seedClaudeMediaLog(tag)

    // Keep the log growing so a missed first match re-arms orphan rematch
    // (one attempt per cooldown); lastUserMessage stays the marker either way.
    await expect
      .poll(
        async () => {
          fs.appendFileSync(
            seeded.logPath,
            JSON.stringify({
              type: 'user',
              timestamp: new Date().toISOString(),
              message: { role: 'user', content: marker },
            }) + '\n'
          )
          return (await pollSessions())?.media?.length ?? 0
        },
        { timeout: 120_000, intervals: [3000, 5000] }
      )
      .toBeGreaterThan(0)

    // Unpatched client: the rail appears on its own.
    await page.goto('/')
    const card = page.getByTestId('session-card').filter({ hasText: windowName }).first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.click()
    await expect(page.getByTestId('media-rail-pill')).toBeVisible()
  } finally {
    spawnSync('tmux', ['kill-window', '-t', windowId])
  }
})

test('media rail expands to thumbnails and opens a lightbox', async ({
  page,
  request,
}) => {
  test.slow()
  const tag = `${process.pid.toString(36)}-${Date.now().toString(36)}`
  const claude = seedClaudeMediaLog(tag)
  const codex = seedCodexMediaLog(tag)
  await waitForMedia(request, claude)
  await waitForMedia(request, codex)

  const media = [
    {
      kind: 'image',
      url: mediaUrl(claude),
      mediaType: 'image/png',
      bytes: PNG_LEN,
      label: 'Read · shot.png',
      width: 96,
      height: 48,
    },
    {
      kind: 'image',
      url: mediaUrl(codex),
      mediaType: 'image/png',
      bytes: PNG_LEN,
      label: 'codex paste',
    },
    {
      kind: 'link',
      url: 'https://claude.ai/artifact/e2eartifact',
      label: 'E2E audit board',
    },
  ]
  await routeSessionsWithMedia(page, media)
  await page.goto('/')

  const card = page.getByTestId('session-card').filter({ hasText: PINNED_SESSION_NAME }).first()
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.click()

  const pill = page.getByTestId('media-rail-pill')
  await expect(pill).toBeVisible()
  await pill.click()

  const rail = page.getByTestId('media-rail')
  await expect(rail).toBeVisible()
  const thumbs = rail.getByTestId('media-thumb')
  await expect(thumbs).toHaveCount(2)

  // Thumbnails actually decode bytes through the endpoint.
  for (const thumb of await thumbs.all()) {
    const img = thumb.locator('img')
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0)
  }

  // The artifact link renders as a chip pointing at the external URL.
  await expect(rail.locator('a[href="https://claude.ai/artifact/e2eartifact"]')).toBeVisible()

  // Tap a thumbnail → lightbox shows the full image; Esc closes it.
  await thumbs.first().click()
  const lightbox = page.getByTestId('media-lightbox')
  await expect(lightbox).toBeVisible()
  await expect
    .poll(async () =>
      lightbox.locator('img').evaluate((el: HTMLImageElement) => el.naturalWidth)
    )
    .toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(lightbox).not.toBeVisible()

  // Collapse returns to the pill.
  await rail.getByLabel('Collapse media rail').click()
  await expect(pill).toBeVisible()
})
