// test-runner-report.ts - explains why a test child process failed.
//
// scripts/test-runner.ts streams thousands of lines from each child. A failure
// buried in that output, or a non-zero exit with no `(fail)` line at all (a
// crash, a signal, an unhandled error between tests), used to surface only as
// a stack trace around one huge command line. OutputScanner watches the stream
// as it passes through, and formatRunSummary() prints one block at the end
// that names each failed child, how it ended, and its failing tests or tail.

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g')
const TAIL_LINES = 40
const MAX_RECORDED = 50

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export type StreamName = 'stdout' | 'stderr'

/** Collects failing test names, error markers, and a tail from child output. */
export class OutputScanner {
  readonly failedTests: string[] = []
  readonly errorLines: string[] = []
  private readonly tailLines: string[] = []
  private readonly partial: Record<StreamName, string> = { stdout: '', stderr: '' }
  private currentFile: string | null = null
  // True between bun's " N pass" line and "Ran N tests", the final summary.
  private inBunSummary = false

  push(stream: StreamName, chunk: string): void {
    const text = this.partial[stream] + chunk
    const lines = text.split('\n')
    this.partial[stream] = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  /** Flushes unterminated last lines once the child has exited. */
  finish(): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      if (this.partial[stream]) this.line(this.partial[stream])
      this.partial[stream] = ''
    }
  }

  get tail(): string[] {
    return [...this.tailLines]
  }

  private line(raw: string): void {
    const line = stripAnsi(raw).replace(/\r$/, '')
    this.tailLines.push(line)
    if (this.tailLines.length > TAIL_LINES) this.tailLines.shift()

    // bun test prints "path/to/file.test.ts:" before each file's results.
    const file = /^(\S+\.test\.[cm]?[jt]sx?):$/.exec(line)
    if (file) {
      this.currentFile = file[1]
      return
    }
    const bunFail = /^\(fail\) (.+)$/.exec(line)
    if (bunFail) {
      const name = this.currentFile ? `${this.currentFile} > ${bunFail[1]}` : bunFail[1]
      record(this.failedTests, name)
      return
    }
    // node --test spec reporter marks failures with ✖; TAP uses "not ok".
    const nodeFail = /^\s*(?:✖ (.+)|not ok \d+ - (.+))$/.exec(line)
    if (nodeFail) {
      const name = (nodeFail[1] ?? nodeFail[2]).trim()
      if (name !== 'failing tests:') record(this.failedTests, name)
      return
    }
    if (/^\((pass|skip|todo)\) /.test(line)) return
    if (/^ \d+ pass$/.test(line)) this.inBunSummary = true
    else if (/^Ran \d+ tests? across /.test(line)) this.inBunSummary = false
    if (
      line === '# Unhandled error between tests' ||
      (this.inBunSummary && /^ [1-9]\d* errors?$/.test(line)) ||
      /^(panic\(|oh no: Bun has crashed)/.test(line)
    ) {
      record(this.errorLines, line.trim())
    }
  }
}

function record(list: string[], value: string): void {
  if (list.length < MAX_RECORDED && !list.includes(value)) list.push(value)
}

export interface CommandResult {
  label: string
  cmd: string[]
  exitCode: number | null
  signal: string | null
  durationMs: number
  failedTests: string[]
  errorLines: string[]
  tail: string[]
  spawnError?: string
  /** Reading the child's output failed (e.g. EPIPE); the child was killed. */
  streamError?: string
  /** A descendant held the pipe after the child exited; reading was cancelled. */
  outputTruncated?: boolean
}

export function commandFailed(result: CommandResult): boolean {
  return (
    result.spawnError !== undefined ||
    result.streamError !== undefined ||
    result.signal !== null ||
    result.exitCode !== 0
  )
}

const TRUNCATED_NOTE =
  'output truncated: a process the child started still held its stdout/stderr after the child exited'

export function describeEnding(result: CommandResult): string {
  const seconds = `${(result.durationMs / 1000).toFixed(1)}s`
  if (result.spawnError !== undefined) return `could not start: ${result.spawnError}`
  if (result.signal) return `killed by ${result.signal} after ${seconds}`
  return `exit code ${result.exitCode} after ${seconds}`
}

export interface LoadInfo {
  loadAverage: number
  cpus: number
}

export function formatRunSummary(results: CommandResult[], load?: LoadInfo): string {
  const failed = results.filter(commandFailed)
  const out: string[] = ['', '==== test-runner summary ====']
  const truncatedPassing = results.filter((result) => result.outputTruncated && !commandFailed(result))
  for (const result of truncatedPassing) out.push(`NOTE ${result.label}: ${TRUNCATED_NOTE}`)
  if (failed.length === 0) {
    out.push(`All ${results.length} test commands passed.`)
    return out.join('\n')
  }
  out.push(`${failed.length} of ${results.length} test commands failed:`)
  for (const result of failed) {
    out.push('', `FAILED ${result.label} (${describeEnding(result)})`)
    out.push(`  command: ${abbreviate(result.cmd)}`)
    if (result.streamError !== undefined) out.push(`  reading output failed (${result.streamError}); the child was killed`)
    if (result.outputTruncated) out.push(`  ${TRUNCATED_NOTE}`)
    if (result.failedTests.length > 0) {
      out.push(`  failing tests (${result.failedTests.length}):`)
      for (const name of result.failedTests) out.push(`    - ${name}`)
    }
    if (result.errorLines.length > 0) {
      out.push('  errors outside tests:')
      for (const line of result.errorLines) out.push(`    - ${line}`)
    }
    if (result.failedTests.length === 0 && result.spawnError === undefined) {
      out.push('  no failing test was reported; last output lines:')
      for (const line of result.tail) out.push(`    | ${line}`)
    }
  }
  if (load) {
    out.push(
      '',
      `1-minute load average ${load.loadAverage.toFixed(1)} on ${load.cpus} CPUs.` +
        (load.loadAverage > load.cpus ? ' The machine is oversubscribed; timing-sensitive tests can fail under this load.' : '')
    )
  }
  return out.join('\n')
}

/** Long file lists make the command unreadable; keep the head and a count. */
export function abbreviate(cmd: string[], keep = 6): string {
  if (cmd.length <= keep + 1) return cmd.join(' ')
  return `${cmd.slice(0, keep).join(' ')} … (+${cmd.length - keep} more args)`
}
