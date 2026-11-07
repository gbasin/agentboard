#!/usr/bin/env bun
// README visuals: `bun run readme:shots`.
//
// 0. Checks for tmux, cwebp and ffmpeg and takes the run lock, before
//    anything is deleted. Then stops the leftovers of a run that died, and
//    refuses if another program has the port.
// 1. Rebuilds the client and boots an isolated Agentboard (private tmux
//    sockets, data dir, HOME and agent homes under /private/tmp/ab-shots).
// 2. Seeds invented sessions: fixture TUIs in tmux panes, matching
//    transcripts, fake `gh` (PR data) and fake `ssh` (a "remote" host).
// 3. Captures the real UI with Playwright (Chromium desktop, WebKit iPhone).
// 4. Composites, optimises and writes assets/readme/*.
// 5. Stops everything it started and deletes the temp directory. SIGINT,
//    SIGTERM and SIGHUP cancel the run and take the same path.
//
// The run lock is held until the process exits, so it covers compositing and
// the final cleanup. Every child process gets the whitelisted environment
// from instance.ts.
//
// Flags: --keep-raw keeps raw captures in /private/tmp/ab-shots-raw (they are
// also kept when compositing fails); --composite-only re-runs step 4 on them.

import { chromium, webkit, type Browser } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureDesktop, captureLoop, capturePhones } from './capture'
import { compose } from './composite'
import {
  acquireLock, assertParentHoldsLock, browserLaunch, checkTools, isolatedEnv, PARENT_LOCK_FLAG, paths, playwrightChildEnv,
  PORT, portInUse, prepareScratch, reapLeftovers, removeRoot, REPO, reset, startServer, startTmux, stopInstance, tmux,
} from './instance'
import { putSettings, seedFiles, setMode, settle } from './seed'
import { writeShims } from './shims'

const RAW = '/private/tmp/ab-shots-raw'
const OUT = join(REPO, 'assets', 'readme')
const keepRaw = process.argv.includes('--keep-raw')
const started = Date.now()
const step = (msg: string) => console.log(`[readme-shots ${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`)
const refuse = (error: unknown): never => {
  console.error(`[readme-shots] ${(error as Error).message}`)
  process.exit(1)
}

if (process.argv.includes('--composite-only')) {
  // Run by the main flow, the parent holds the lock and ROOT still exists.
  // Run by hand, take the lock and make the browser's HOME and TMPDIR.
  const child = process.argv.includes(PARENT_LOCK_FLAG)
  try {
    if (child) assertParentHoldsLock()
    else acquireLock()
  } catch (error) {
    refuse(error)
  }
  if (!child) prepareScratch()
  let code = 0
  try {
    await compose({ raw: RAW, out: OUT, ...JSON.parse(readFileSync(join(RAW, 'meta.json'), 'utf-8')) })
  } catch (error) {
    console.error(error)
    code = 1
  }
  if (!child) removeRoot()
  process.exit(code)
}

try {
  checkTools()
  acquireLock()
} catch (error) {
  refuse(error)
}
// With the lock held, anything of ours that still runs was left by a run that
// died without cleanup (SIGKILL, power loss). Its server may hold the port.
reapLeftovers()
for (let waited = 0; portInUse(PORT) && waited < 3000; waited += 100) Bun.sleepSync(100)
if (portInUse(PORT)) {
  console.error(`[readme-shots] port ${PORT} is in use by another program; refusing to start`)
  process.exit(1)
}

class Cancelled extends Error {}
let cancelled = false
/** Call after every awaited step: a signal that arrived meanwhile ends the run here. */
const checkpoint = () => {
  if (cancelled) throw new Cancelled()
}

const browsers: Browser[] = []
const children = new Set<ChildProcess>()

/** A child process with the given environment; killed by stop(). Resolves with its exit code. */
function run(command: string, args: string[], env: Record<string, string>, stdio: 'inherit' | 'quiet'): Promise<number | null> {
  const child = spawn(command, args, { cwd: REPO, env, stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'ignore', 'inherit'] })
  children.add(child)
  return new Promise((resolve) => {
    child.once('error', () => resolve(null))
    child.once('exit', (code) => resolve(code))
  }).finally(() => children.delete(child)) as Promise<number | null>
}

let stopChain: Promise<void> = Promise.resolve()
/**
 * Stops what exists now: child processes, browsers, the instance. Calls are
 * serialised and repeatable, so a later call also stops anything that was
 * still being created during an earlier one.
 */
const stop = () => {
  stopChain = stopChain.then(async () => {
    for (const child of children) child.kill('SIGTERM')
    for (const browser of browsers.splice(0)) await browser.close().catch(() => {})
    await stopInstance()
  })
  return stopChain
}

let finishing: Promise<never> | null = null
/** The one way out after the lock is taken: stop everything, delete ROOT, exit. */
const finish = (code: number) => {
  finishing ??= (async () => {
    await stop()
    removeRoot()
    // Raw captures are only worth keeping once meta.json makes them composable.
    if (!keepRaw && !(code === 1 && existsSync(join(RAW, 'meta.json')))) rmSync(RAW, { recursive: true, force: true })
    process.exit(code)
  })()
  return finishing
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (cancelled) return
    cancelled = true
    console.error(`[readme-shots] ${signal}: stopping`)
    // Stopping makes the main flow's pending step fail or return; it then
    // sees the flag and finishes. The timer covers a step that does neither.
    void stop()
    setTimeout(() => void finish(130), 20_000)
  })
}
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error) => {
    if (!cancelled) console.error(error)
    void finish(cancelled ? 130 : 1)
  })
}

let code = 0
try {
  reset()
  // Always rebuild: a dist/ left by another branch would be captured silently.
  step('building client')
  const built = await run('bun', ['--no-env-file', 'run', 'build'], isolatedEnv(), 'quiet')
  checkpoint()
  if (built !== 0) throw new Error('client build failed')

  rmSync(RAW, { recursive: true, force: true })
  mkdirSync(RAW, { recursive: true })
  mkdirSync(OUT, { recursive: true })
  // Register each browser before the checkpoint, so one that finishes
  // launching after a signal is still closed.
  const browser = await chromium.launch(browserLaunch())
  browsers.push(browser)
  checkpoint()
  const phoneBrowser = await webkit.launch(browserLaunch())
  browsers.push(phoneBrowser)
  checkpoint()

  step('starting isolated tmux + seeding scenes')
  writeShims()
  startTmux()
  const seeded = await seedFiles(browser)
  checkpoint()
  tmux(['set-option', '-g', 'status', 'off'], paths.remoteSocket)
  step('starting agentboard')
  await startServer()
  checkpoint()
  await putSettings({ theme: 'light', showLastUserMessage: true, showProjectName: true, sessionSortMode: 'status' })
  checkpoint()
  step('waiting for log matching')
  await settle(seeded)
  checkpoint()
  step('capturing desktop')
  const { crops, metrics } = await captureDesktop(browser, RAW)
  checkpoint()
  step('capturing status loop')
  const loop = await captureLoop(browser, RAW, (mode) => setMode('orders-migration', mode))
  checkpoint()
  step('capturing phone')
  Object.assign(crops, await capturePhones(phoneBrowser, RAW, (id, mode) => setMode(id, mode)))
  checkpoint()
  step('stopping instance')
  await stop()
  checkpoint()
  const meta = { crops, metrics, frames: loop.frames, loopCrop: loop.crop }
  writeFileSync(join(RAW, 'meta.json'), JSON.stringify(meta))
  step('compositing')
  // In a fresh process: a Chromium launched here, after the capture
  // browsers, intermittently never loaded the layout pages.
  const composed = await run(process.execPath, ['--no-env-file', import.meta.path, '--composite-only', PARENT_LOCK_FLAG], playwrightChildEnv(), 'inherit')
  checkpoint()
  if (composed !== 0) throw new Error('compositing failed')
  step(`done: ${OUT}`)
} catch (error) {
  code = cancelled ? 130 : 1
  if (!cancelled) console.error(error)
  if (code === 1 && existsSync(join(RAW, 'meta.json'))) console.error(`[readme-shots] raw captures kept in ${RAW}; retry with --composite-only`)
}
await finish(code)
