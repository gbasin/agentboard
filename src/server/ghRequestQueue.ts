// Shared admission for PR metadata subprocesses. FIFO across info/checks tiers;
// a timeout kills the process but never releases admission before it settles.
import { sanitizedTmuxEnv } from './tmuxEnv'

export type GhResult = Record<string, unknown> | null
export type GhRequest = { repo: string; number: number; fields: string }
type Job = {
  request: GhRequest
  key: string
  resolve: (value: GhResult) => void
}

export class GhRequestQueue {
  private readonly outstanding = new Map<string, Promise<GhResult>>()
  private readonly waiting: Job[] = []
  private active = 0

  constructor(
    private readonly run: (
      request: GhRequest
    ) => Promise<GhResult> = runGhRequest,
    private readonly concurrency = 4,
    private readonly capacity = 128
  ) {}

  request(repo: string, number: number, fields: string): Promise<GhResult> {
    const key = JSON.stringify([repo, number, fields])
    const existing = this.outstanding.get(key)
    if (existing) return existing
    if (this.outstanding.size >= this.capacity) return Promise.resolve(null)
    const result = Promise.withResolvers<GhResult>()
    this.outstanding.set(key, result.promise)
    this.waiting.push({
      request: { repo, number, fields },
      key,
      resolve: result.resolve,
    })
    this.drain()
    return result.promise
  }

  private drain(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!
      this.active++
      void this.finish(job)
    }
  }

  private async finish(job: Job): Promise<void> {
    let result: GhResult = null
    try {
      result = await this.run(job.request)
    } catch {
      // A missing gh executable or failed process is an unavailable PR.
    } finally {
      this.active--
      this.outstanding.delete(job.key)
      job.resolve(result)
      this.drain()
    }
  }
}

export interface GhProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill: (signal: 'SIGKILL') => void
}

async function discard(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {
      /* Drain without retaining stderr. */
    }
  } finally {
    reader.releaseLock()
  }
}

export async function runGhRequest(
  request: GhRequest,
  spawn: (
    args: string[],
    options: {
      stdout: 'pipe'
      stderr: 'pipe'
      env: Record<string, string>
    }
  ) => GhProcess = (args, options) => Bun.spawn(args, options),
  timeoutMs = 8_000
): Promise<GhResult> {
  // Spawn can throw before any process exists; the queue handles that failure.
  const proc = spawn(
    [
      'gh',
      'pr',
      'view',
      String(request.number),
      '--repo',
      request.repo,
      '--json',
      request.fields,
    ],
    { stdout: 'pipe', stderr: 'pipe', env: sanitizedTmuxEnv() }
  )
  let killed = false
  const kill = () => {
    killed = true
    try {
      proc.kill('SIGKILL')
    } catch {
      /* May already have exited. */
    }
  }
  const timeout = setTimeout(kill, timeoutMs)
  try {
    const read = <T>(promise: Promise<T>) =>
      promise.catch((error: unknown) => {
        kill()
        throw error
      })
    // allSettled matters: a pipe failure must not free the process slot early.
    const [out, err, exit] = await Promise.allSettled([
      read(new Response(proc.stdout).text()),
      read(discard(proc.stderr)),
      proc.exited,
    ])
    if (
      killed ||
      out.status !== 'fulfilled' ||
      err.status !== 'fulfilled' ||
      exit.status !== 'fulfilled' ||
      exit.value !== 0
    )
      return null
    const parsed: unknown = JSON.parse(out.value)
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}
