// test-runner-child.ts - runs one test child and records how it ended.
//
// The child's stdout/stderr are piped through to ours while an OutputScanner
// watches them. A pipe reaches EOF only when every process holding it closes
// it, and tests spawn helpers (sh -c, tmux attach) that inherit the child's
// stdio and can outlive it. So once the child has exited, the drains get a
// short grace period and are then cancelled; the result says the output was
// truncated. A stream error kills the child and waits for it, so a child that
// is still running never overlaps the next command's tmux socket and data dir.

import { type CommandResult, OutputScanner, type StreamName } from './test-runner-report'

export interface OutputSink {
  write(chunk: Uint8Array): boolean
  once(event: 'drain', listener: () => void): unknown
}

export interface RunChildOptions {
  label: string
  cmd: string[]
  env: NodeJS.ProcessEnv
  /** How long to keep reading after the child exits before cancelling. */
  graceMs?: number
  sinks?: Record<StreamName, OutputSink>
}

const DEFAULT_GRACE_MS = 2000

/** Writes a chunk and waits for 'drain' when the sink is backed up. */
async function writeWithBackpressure(sink: OutputSink, chunk: Uint8Array) {
  if (!sink.write(chunk)) await new Promise<void>((resolve) => sink.once('drain', resolve))
}

async function drain(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  name: StreamName,
  sink: OutputSink,
  scanner: OutputScanner
) {
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    await writeWithBackpressure(sink, value)
    scanner.push(name, decoder.decode(value, { stream: true }))
  }
  scanner.push(name, decoder.decode())
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function runChild(options: RunChildOptions): Promise<CommandResult> {
  const { label, cmd, env } = options
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const sinks = options.sinks ?? { stdout: process.stdout, stderr: process.stderr }
  const scanner = new OutputScanner()
  const startedAt = performance.now()
  const result: CommandResult = {
    label,
    cmd,
    exitCode: null,
    signal: null,
    durationMs: 0,
    failedTests: scanner.failedTests,
    errorLines: scanner.errorLines,
    tail: [],
  }
  const finish = () => {
    scanner.finish()
    result.tail = scanner.tail
    result.durationMs = performance.now() - startedAt
    return result
  }

  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>
  try {
    proc = Bun.spawn({ cmd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  } catch (error) {
    result.spawnError = message(error)
    return finish()
  }

  const readers = [proc.stdout.getReader(), proc.stderr.getReader()] as const
  const drained = Promise.all([
    drain(readers[0], 'stdout', sinks.stdout, scanner),
    drain(readers[1], 'stderr', sinks.stderr, scanner),
  ]).then(
    () => true,
    (error) => {
      // e.g. EPIPE on our own stdout. Stop the child before recording it.
      result.streamError = message(error)
      proc.kill()
      return true
    }
  )

  await proc.exited
  result.exitCode = proc.exitCode
  result.signal = proc.signalCode ?? null

  let timer: ReturnType<typeof setTimeout> | undefined
  const finished = await Promise.race([
    drained,
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), graceMs) }),
  ])
  clearTimeout(timer)
  if (!finished) {
    // A descendant still holds the pipe; stop reading so the run can go on.
    result.outputTruncated = true
    await Promise.allSettled(readers.map((reader) => reader.cancel()))
    await drained
  }
  return finish()
}
