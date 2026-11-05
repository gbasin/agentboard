#!/usr/bin/env bun
// README visuals: `bun run readme:shots`.
//
// 1. Builds the client if needed and boots an isolated Agentboard (private
//    tmux sockets, data dir, HOME and agent homes under /private/tmp/ab-shots).
// 2. Seeds invented sessions: fixture TUIs in tmux panes, matching
//    transcripts, fake `gh` (PR data) and fake `ssh` (a "remote" host).
// 3. Captures the real UI with Playwright (Chromium desktop, WebKit iPhone).
// 4. Composites, optimises and writes assets/readme/*.
// 5. Stops everything it started and deletes the temp directory.
//
// Flags: --keep-raw keeps raw captures in /private/tmp/ab-shots-raw;
// --composite-only re-runs step 4 on those kept captures.

import { chromium, webkit } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureDesktop, captureLoop, capturePhones } from './capture'
import { compose } from './composite'
import { REPO, reset, startServer, startTmux, teardown } from './instance'
import { putSettings, seedFiles, setMode, settle } from './seed'
import { writeShims } from './shims'

const RAW = '/private/tmp/ab-shots-raw'
const OUT = join(REPO, 'assets', 'readme')
const keepRaw = process.argv.includes('--keep-raw')
const started = Date.now()
const step = (msg: string) => console.log(`[readme-shots ${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`)

if (process.env.TMUX) {
  // Not fatal (every tmux call uses -S), but worth knowing.
  step('note: $TMUX is set; it is ignored, all tmux calls use private sockets')
}

if (process.argv.includes('--composite-only')) {
  await compose({ raw: RAW, out: OUT, ...JSON.parse(readFileSync(join(RAW, 'meta.json'), 'utf-8')) })
  process.exit(0)
}

if (!existsSync(join(REPO, 'dist', 'client', 'index.html'))) {
  step('building client')
  const build = spawnSync('bun', ['run', 'build'], { cwd: REPO, stdio: 'inherit' })
  if (build.status !== 0) process.exit(1)
}

rmSync(RAW, { recursive: true, force: true })
mkdirSync(RAW, { recursive: true })
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch()
const phoneBrowser = await webkit.launch()
let failed = false
const stop = async () => {
  await browser.close().catch(() => {})
  await phoneBrowser.close().catch(() => {})
  await teardown()
}
process.on('SIGINT', () => { void stop().then(() => process.exit(130)) })

try {
  step('starting isolated tmux + seeding scenes')
  reset()
  writeShims()
  startTmux()
  const seeded = await seedFiles(browser)
  step('starting agentboard')
  await startServer()
  await putSettings({ theme: 'light', showLastUserMessage: true, showProjectName: true, sessionSortMode: 'status' })
  step('waiting for log matching')
  await settle(seeded)
  step('capturing desktop')
  const crops = await captureDesktop(browser, RAW)
  step('capturing status loop')
  // Fixed order for the loop: status sort would move the card on every flip.
  await putSettings({ sessionSortMode: 'created' })
  const frames = await captureLoop(browser, RAW, (mode) => setMode('orders-migration', mode))
  await putSettings({ sessionSortMode: 'status' })
  step('capturing phone')
  await capturePhones(phoneBrowser, RAW, (id, mode) => setMode(id, mode))
  step('stopping instance')
  await stop()
  writeFileSync(join(RAW, 'meta.json'), JSON.stringify({ crops, frames }))
  step('compositing')
  await compose({ raw: RAW, out: OUT, crops, frames })
  step(`done: ${OUT}`)
} catch (error) {
  failed = true
  console.error(error)
  await stop()
} finally {
  if (!keepRaw && !failed) rmSync(RAW, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
