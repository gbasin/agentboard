// ghCommand.ts - Argument-array `gh` invocation with a timeout, bounded
// output, and token redaction (plan-execution D14), modeled on
// `gitCommand.ts`: never a shell string, every argument its own argv element,
// so injection via branch names or paths is not possible. Every gh call
// Kawai makes is recorded on an effect row, so the output this returns is
// what gets recorded: token-looking substrings are replaced with a marker
// before the caller sees them.
import { cleanGitEnv } from '../../git/gitCommand'

export const GH_TIMEOUT_MS = 60_000
export const GH_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * GitHub credential shapes as they can appear in echoed argv or output:
 * classic token prefixes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) and the
 * fine-grained `github_pat_` form. Only long runs match, so ordinary text
 * never trips the redaction.
 */
const GH_TOKEN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g

/** Replace credential-looking substrings with a marker, so recorded output never carries one. */
export function redactTokens(text: string): string {
  return text.replace(GH_TOKEN, '[redacted]')
}

export interface GhCommandOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  env?: Record<string, string>
}

export interface GhCommandResult {
  ok: boolean
  exitCode: number | null
  /** Redacted and bounded, the form an effect row records. */
  stdout: string
  stderr: string
  /**
   * Set only when `gh` itself could not be started (missing or
   * non-executable on the PATH, an invalid cwd or env): the redacted,
   * bounded spawn error. Absent on every other outcome — a null exitCode
   * without it stays the timeout/killed shape.
   */
  spawnError?: string
}

/**
 * Run `gh` asynchronously with a timeout, an output bound, and redaction.
 * The executor's only subprocess shape: a timeout kills the process and the
 * killed exit resolves as a non-success with exitCode null (a transient
 * outcome the caller classifies, never a crash). A spawn failure is its own
 * non-success shape — `spawnError` set — so the caller can tell "gh never
 * ran" from "gh was killed".
 */
export async function runGh(args: string[], options: GhCommandOptions = {}): Promise<GhCommandResult> {
  const { cwd, timeoutMs = GH_TIMEOUT_MS, maxOutputBytes = GH_MAX_OUTPUT_BYTES, env } = options
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['gh', ...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      env: env ? { ...cleanGitEnv(), ...env } : cleanGitEnv(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (error) {
    // gh could not be started: not on the PATH, not executable, or an
    // invalid spawn context (cwd, env). A distinct non-success carrying the
    // original error, so a caller never reads it as a timeout or as gh's
    // own verdict (D14's gh-spawn row) — redacted and bounded like output.
    const message = redactTokens(error instanceof Error ? error.message : String(error))
    return { ok: false, exitCode: null, stdout: '', stderr: '', spawnError: message.slice(0, maxOutputBytes) }
  }
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; proc.kill() }, timeoutMs)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ])
    const bound = (text: string): string => {
      const redacted = redactTokens(text)
      return redacted.length > maxOutputBytes ? redacted.slice(0, maxOutputBytes) : redacted
    }
    // A process this wrapper killed resolves its exit as null, so a caller
    // never mistakes a timeout for gh's own exit code.
    const code = timedOut ? null : exitCode
    return { ok: code === 0, exitCode: code, stdout: bound(stdout), stderr: bound(stderr) }
  } catch {
    return { ok: false, exitCode: null, stdout: '', stderr: '' }
  } finally {
    clearTimeout(timer)
  }
}
