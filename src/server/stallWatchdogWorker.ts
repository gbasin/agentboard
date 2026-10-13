/// <reference lib="webworker" />
/**
 * Worker half of the stall watchdog — see stallWatchdog.ts for the design.
 *
 * Receives `init` once, then a `beat` per event-loop monitor tick carrying
 * the main thread's send timestamp. Its own interval measures the gap to the
 * newest sent timestamp: a gap past thresholdMs means the main thread is
 * stalled right now, so it runs `sample <pid>` via spawnSync — blocking is
 * safe here because this thread is not the loop being watched. Results are
 * posted back; the main thread logs them.
 */
import fs from 'node:fs'
import path from 'node:path'
import { StallGapTracker } from './stallGapTracker'

export type StallWatchdogWorkerRequest =
  | {
      kind: 'init'
      pid: number
      sampleDir: string
      thresholdMs: number
      sampleSeconds: number
      cooldownMs: number
      maxSamples: number
      checkIntervalMs: number
    }
  | { kind: 'beat'; sentAt: number }
  | { kind: 'shutdown' }

export type StallWatchdogWorkerResponse =
  | { kind: 'ready' }
  | { kind: 'sampled'; path: string; gapMs: number; sampleMs: number }
  | { kind: 'sample_failed'; gapMs: number; error: string }
  | { kind: 'disabled'; reason: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

type InitConfig = Extract<StallWatchdogWorkerRequest, { kind: 'init' }>

let cfg: InitConfig | null = null
let tracker: StallGapTracker | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null

function post(response: StallWatchdogWorkerResponse): void {
  ctx.postMessage(response)
}

function pruneSamples(): void {
  if (!cfg) return
  try {
    const entries = fs
      .readdirSync(cfg.sampleDir)
      .filter((entry) => /^stall-.*\.txt$/.test(entry))
      .sort()
    for (const entry of entries.slice(0, Math.max(0, entries.length - cfg.maxSamples))) {
      fs.rmSync(path.join(cfg.sampleDir, entry), { force: true })
    }
  } catch {
    // Pruning is best-effort; a sample already landed and is what matters.
  }
}

function runSample(gapMs: number): void {
  if (!cfg || !tracker) return
  const startedAt = Date.now()
  try {
    fs.mkdirSync(cfg.sampleDir, { recursive: true })
    const file = path.join(
      cfg.sampleDir,
      `stall-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    )
    const result = Bun.spawnSync(
      ['sample', String(cfg.pid), String(cfg.sampleSeconds), '-file', file],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        // Attach + capture + report can exceed the nominal sample duration.
        timeout: (cfg.sampleSeconds + 10) * 1000,
      }
    )
    if (result.exitCode !== 0) {
      const error = result.stderr?.toString().trim() || `sample exited ${result.exitCode}`
      if (/ENOENT|cannot execute|not found/i.test(error)) {
        tracker.disable()
        post({ kind: 'disabled', reason: error })
        return
      }
      post({ kind: 'sample_failed', gapMs, error })
      return
    }
    post({ kind: 'sampled', path: file, gapMs, sampleMs: Date.now() - startedAt })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT/.test(message)) {
      tracker.disable()
      post({ kind: 'disabled', reason: message })
      return
    }
    post({ kind: 'sample_failed', gapMs, error: message })
  } finally {
    // Prune on success and failure alike: a killed sample can leave a partial
    // report that still counts against retention.
    pruneSamples()
  }
}

ctx.onmessage = (event: MessageEvent<StallWatchdogWorkerRequest>) => {
  const payload = event.data
  if (!payload || typeof payload !== 'object' || !('kind' in payload)) return

  if (payload.kind === 'shutdown') {
    if (checkInterval) clearInterval(checkInterval)
    ctx.close()
    return
  }
  if (payload.kind === 'beat') {
    tracker?.beat(payload.sentAt)
    return
  }

  cfg = payload
  tracker = new StallGapTracker({
    thresholdMs: payload.thresholdMs,
    cooldownMs: payload.cooldownMs,
  })
  if (checkInterval) clearInterval(checkInterval)
  checkInterval = setInterval(() => {
    if (!tracker) return
    const gapMs = tracker.check()
    if (gapMs !== null) runSample(gapMs)
  }, payload.checkIntervalMs)
  post({ kind: 'ready' })
}
