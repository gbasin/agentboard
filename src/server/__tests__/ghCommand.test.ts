// ghCommand (plan-execution D14): argument-array gh over a stub executable
// on a private PATH — argv passes through untouched (one element per
// argument), exit codes and both streams come back, a timeout kills the
// process as exitCode null, a spawn failure (gh missing, non-executable, or
// an invalid cwd) carries its own diagnostic, output is capped, and
// token-looking substrings are redacted from what a caller would record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactTokens, runGh } from '../plans/landing/ghCommand'

let dir: string
let stubDir: string
let env: Record<string, string>
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-gh-'))
  stubDir = path.join(dir, 'bin')
  env = { PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}` }
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const stubGh = (script: string): void => {
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(path.join(stubDir, 'gh'), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}

describe('runGh', () => {
  test('argv passes through one element per argument, and a zero exit is ok', async () => {
    stubGh('printf "%s\\n" "$@"')
    const result = await runGh(['pr', 'view', 'kawai/a b'], { env })
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(result.stdout).toBe('pr\nview\nkawai/a b\n')
  })

  test('a non-zero exit code is reported with its stderr', async () => {
    stubGh('echo "gh: no such ref" >&2\nexit 4')
    const result = await runGh(['api', 'repos/x/y'], { env })
    expect(result).toMatchObject({ ok: false, exitCode: 4, stdout: '' })
    expect(result.stderr).toContain('no such ref')
  })

  test('a timeout kills the process: a non-success with exitCode null and no spawn diagnostic', async () => {
    stubGh('exec sleep 5')
    const result = await runGh(['pr', 'list'], { env, timeoutMs: 150 })
    expect(result).toMatchObject({ ok: false, exitCode: null, stdout: '', stderr: '' })
    // The killed shape stays bare: a caller must not read a timeout as a
    // spawn failure.
    expect(result.spawnError).toBeUndefined()
  })

  test('a missing gh on the PATH is a non-success carrying the spawn diagnostic', async () => {
    fs.mkdirSync(stubDir, { recursive: true })
    const result = await runGh(['auth', 'status'], { env: { PATH: stubDir } })
    expect(result).toMatchObject({ ok: false, exitCode: null, stdout: '', stderr: '' })
    expect(typeof result.spawnError).toBe('string')
    expect(result.spawnError!.length).toBeGreaterThan(0)
  })

  test('a non-executable gh on the PATH is a spawn failure too', async () => {
    fs.mkdirSync(stubDir, { recursive: true })
    fs.writeFileSync(path.join(stubDir, 'gh'), '#!/bin/sh\necho hi\n') // no exec bit
    const result = await runGh(['auth', 'status'], { env: { PATH: stubDir } })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(typeof result.spawnError).toBe('string')
    expect(result.spawnError!.length).toBeGreaterThan(0)
  })

  test('an invalid spawn context (a cwd that does not exist) carries the spawn diagnostic', async () => {
    stubGh('echo hi')
    const result = await runGh(['auth', 'status'], { env, cwd: path.join(dir, 'no-such-cwd') })
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBeNull()
    expect(typeof result.spawnError).toBe('string')
  })

  test('a small maxOutputBytes bounds the real spawn diagnostic to exactly that limit', async () => {
    fs.mkdirSync(stubDir, { recursive: true })
    const bounded = await runGh(['auth', 'status'], { env: { PATH: stubDir }, maxOutputBytes: 24 })
    const full = await runGh(['auth', 'status'], { env: { PATH: stubDir } })
    expect(bounded.ok).toBe(false)
    expect(full.ok).toBe(false)
    expect(typeof bounded.spawnError).toBe('string')
    expect(typeof full.spawnError).toBe('string')
    // The bound cuts the same actual diagnostic the unbounded call carries:
    // the expected remainder derives from that diagnostic, never from a
    // Bun-version-specific error string.
    expect(full.spawnError!.length).toBeGreaterThan(24)
    expect(bounded.spawnError).toBe(full.spawnError!.slice(0, 24))
    expect(bounded.spawnError!.length).toBe(24)
  })

  test('the spawn catch redacts tokens before bounding, through the real catch', async () => {
    const originalSpawn = Bun.spawn
    // Synthetic token-shaped text and padding, thrown from the spawn seam
    // the real catch reads: redaction must run before the byte bound, or a
    // token run cut mid-way would survive un-redacted.
    const token = `ghp_${'A'.repeat(24)}`
    const message = `started: ${token} ${'y'.repeat(4000)}`
    let bounded: Awaited<ReturnType<typeof runGh>> | null = null
    let full: Awaited<ReturnType<typeof runGh>> | null = null
    ;(Bun as unknown as { spawn: unknown }).spawn = (() => { throw new Error(message) }) as typeof Bun.spawn
    try {
      bounded = await runGh(['auth', 'status'], { env: { PATH: stubDir }, maxOutputBytes: 20 })
      full = await runGh(['auth', 'status'], { env: { PATH: stubDir } })
    } finally {
      ;(Bun as unknown as { spawn: unknown }).spawn = originalSpawn
    }
    expect(bounded!.ok).toBe(false)
    expect(full!.ok).toBe(false)
    // Exact redaction over the whole diagnostic, then the exact bound — the
    // pairing pins the order: slice-first would leave `ghp_` visible.
    expect(full!.spawnError).toBe(redactTokens(message))
    expect(bounded!.spawnError).toBe(redactTokens(message).slice(0, 20))
    expect(bounded!.spawnError).not.toContain('ghp_')
  })

  test('output is capped at maxOutputBytes', async () => {
    stubGh('yes a | head -c 100000')
    const result = await runGh(['api', 'big'], { env, maxOutputBytes: 1000 })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('a\n'.repeat(500))
  })

  test('tokens are redacted from stdout and stderr, and truncation keeps the marker', async () => {
    stubGh('echo "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234 and github_pat_11AAAAAAAAAAAAAAAAAAAAAA_x" >&2\necho "auth as ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZ12 done"')
    const result = await runGh(['auth', 'status'], { env })
    expect(result.ok).toBe(true)
    expect(result.stdout).toBe('auth as [redacted] done\n')
    expect(result.stderr).toBe('token [redacted] and [redacted]\n')
  })

  test('ordinary text with short gh-prefixes is untouched', async () => {
    stubGh('echo "ghp_short and github_pat_tiny"')
    const result = await runGh(['api', 'x'], { env })
    expect(result.stdout).toBe('ghp_short and github_pat_tiny\n')
  })
})

describe('redactTokens', () => {
  test('covers the classic prefixes standalone', () => {
    expect(redactTokens('gho_0123456789012345678901')).toBe('[redacted]')
    expect(redactTokens('x ghu_01234567890123456789 y')).toBe('x [redacted] y')
    expect(redactTokens('ghr_012345678901234567890123')).toBe('[redacted]')
  })
})
