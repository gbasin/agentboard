#!/usr/bin/env bun
// README visuals: `bun run readme:shots`.
//
// 0. Checks for tmux, cwebp and ffmpeg, takes the run lock, and refuses if
//    the port is in use, all before anything is deleted.
// 1. Rebuilds the client and boots an isolated Agentboard (private tmux
//    sockets, data dir, HOME and agent homes under /private/tmp/ab-shots).
// 2. Seeds invented sessions: fixture TUIs in tmux panes, matching
//    transcripts, fake `gh` (PR data) and fake `ssh` (a "remote" host).
// 3. Captures the real UI with Playwright (Chromium desktop, WebKit iPhone).
// 4. Composites, optimises and writes assets/readme/*.
// 5. Stops everything it started, deletes the temp directory and the lock.
//    SIGINT, SIGTERM and SIGHUP run the same teardown.
//
// Flags: --keep-raw keeps raw captures in /private/tmp/ab-shots-raw (they are
// also kept when compositing fails); --composite-only re-runs step 4 on them.

import { chromium, webkit, type Browser } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureDesktop, captureLoop, capturePhones } from './capture'
import { compose } from './composite'
import { acquireLock, checkTools, LAUNCH, paths, PORT, portInUse, recordTmuxServer, releaseLock, REPO, reset, startServer, startTmux, teardown, tmux } from './instance'
import { putSettings, seedFiles, setMode, settle } from './seed'
import { writeShims } from './shims'

const RAW = '/private/tmp/ab-shots-raw'
const OUT = join(REPO, 'assets', 'readme')
const keepRaw = process.argv.includes('--keep-raw')
const started = Date.now()
const step = (msg: string) => console.log(`[readme-shots ${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`)

if (process.argv.includes('--composite-only')) {
  await compose({ raw: RAW, out: OUT, ...JSON.parse(readFileSync(join(RAW, 'meta.json'), 'utf-8')) })
  process.exit(0)
}

try {
  checkTools()
  acquireLock()
} catch (error) {
  console.error(`[readme-shots] ${(error as Error).message}`)
  process.exit(1)
}
if (portInUse(PORT)) {
  releaseLock()
  console.error(`[readme-shots] port ${PORT} is already in use; refusing to start (nothing was changed)`)
  process.exit(1)
}

/** Raw captures are only worth keeping once meta.json makes them composable. */
const cleanRaw = (failed: boolean) => {
  if (keepRaw || (failed && existsSync(join(RAW, 'meta.json')))) return
  rmSync(RAW, { recursive: true, force: true })
}

const browsers: Browser[] = []
let stopping: Promise<void> | null = null
/** Runs teardown exactly once, however many times it is requested. */
const stop = () => {
  stopping ??= (async () => {
    for (const b of browsers) await b.close().catch(() => {})
    await teardown()
  })()
  return stopping
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    console.error(`[readme-shots] ${signal}: stopping`)
    void stop().then(() => {
      cleanRaw(false)
      process.exit(130)
    })
  })
}

let failed = false
try {
  // Always rebuild: a dist/ left by another branch would be captured silently.
  step('building client')
  const build = spawnSync('bun', ['run', 'build'], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] })
  if (build.status !== 0) throw new Error('client build failed')

  rmSync(RAW, { recursive: true, force: true })
  mkdirSync(RAW, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch(LAUNCH)
  browsers.push(browser)
  const phoneBrowser = await webkit.launch(LAUNCH)
  browsers.push(phoneBrowser)

  step('starting isolated tmux + seeding scenes')
  reset()
  writeShims()
  startTmux()
  const seeded = await seedFiles(browser)
  recordTmuxServer(paths.remoteSocket)
  tmux(['set-option', '-g', 'status', 'off'], paths.remoteSocket)
  step('starting agentboard')
  await startServer()
  await putSettings({ theme: 'light', showLastUserMessage: true, showProjectName: true, sessionSortMode: 'status' })
  step('waiting for log matching')
  await settle(seeded)
  step('capturing desktop')
  const { crops, metrics } = await captureDesktop(browser, RAW)
  step('capturing status loop')
  const loop = await captureLoop(browser, RAW, (mode) => setMode('orders-migration', mode))
  step('capturing phone')
  Object.assign(crops, await capturePhones(phoneBrowser, RAW, (id, mode) => setMode(id, mode)))
  step('stopping instance')
  await stop()
  const meta = { crops, metrics, frames: loop.frames, loopCrop: loop.crop }
  writeFileSync(join(RAW, 'meta.json'), JSON.stringify(meta))
  step('compositing')
  // In a fresh process: a Chromium launched here, after the capture
  // browsers, intermittently never loaded the layout pages.
  const composed = spawnSync(process.execPath, ['--no-env-file', import.meta.path, '--composite-only'], { cwd: REPO, stdio: 'inherit' })
  if (composed.status !== 0) throw new Error('compositing failed')
  step(`done: ${OUT}`)
} catch (error) {
  failed = true
  console.error(error)
  await stop()
  if (existsSync(join(RAW, 'meta.json'))) console.error(`[readme-shots] raw captures kept in ${RAW}; retry with --composite-only`)
} finally {
  cleanRaw(failed)
}
process.exit(failed ? 1 : 0)
