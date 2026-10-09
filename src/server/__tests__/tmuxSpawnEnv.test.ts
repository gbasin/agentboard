// Spawn-env wiring guard: Bun.spawn*/spawnSync calls that omit `env` do NOT
// get the current process.env — Bun hands the child a snapshot of the
// process-start environ. Any post-start mutation (most importantly
// tmuxIsolation's `delete process.env.TMUX` when TMUX_TMPDIR isolates the
// instance onto a private socket) is invisible to env-less spawns, and Bun
// Workers never see those mutations at all. Their tmux clients would talk to
// the live agentboard server, which is exactly the kind of leak that can
// kill or hijack real windows.
//
// This test is a tripwire, not a parser: it scans src/server for direct
// Bun.spawn*/spawnSync calls whose argv starts a tmux client and asserts each
// passes an explicit env. Callers going through timedSpawnSync/
// timedSpawnAsync are covered by those helpers' sanitized default instead.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { timedSpawnSync } from '../syncSpawnTiming'

const SERVER_DIR = join(import.meta.dir, '..')

function* serverSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'fixtures') yield* serverSources(path)
    } else if (entry.endsWith('.ts')) {
      yield path
    }
  }
}

/** Extract the source text of each `Callee(` … `)` call (balanced parens). */
function callTexts(source: string, callee: RegExp): string[] {
  const texts: string[] = []
  let match: RegExpExecArray | null
  while ((match = callee.exec(source))) {
    const open = source.indexOf('(', match.index)
    if (open < 0) break
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1
      else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    texts.push(source.slice(match.index, end + 1))
    callee.lastIndex = end + 1
  }
  return texts
}

describe('tmux spawn env wiring', () => {
  const spawnCall = /\bBun\.spawn(?:Sync)?\s*\(/g

  test('every direct Bun.spawn* call starting a tmux client passes explicit env', () => {
    const violations: string[] = []
    let covered = 0
    for (const path of serverSources(SERVER_DIR)) {
      const source = readFileSync(path, 'utf-8')
      for (const text of callTexts(source, spawnCall)) {
        // argv whose first element is a tmux binary.
        if (!/^\s*Bun\.spawn(?:Sync)?\s*\(\s*\[\s*['"][^'"]*tmux['"]/.test(text)) continue
        covered += 1
        if (!/\benv\s*:/.test(text)) {
          const line = source.slice(0, source.indexOf(text)).split('\n').length
          violations.push(`${path}:${line}`)
        }
      }
    }
    expect(covered).toBeGreaterThan(0)
    expect(violations).toEqual([])
  })

  test('timedSpawnSync spawns with a sanitized env by default', () => {
    const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
    const original = bunAny.spawnSync
    let seenEnv: Record<string, string | undefined> | undefined
    bunAny.spawnSync = ((command: string[], options?: { env?: Record<string, string | undefined> }) => {
      seenEnv = options?.env
      return {
        exitCode: 0,
        signalCode: null,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        success: true,
        pid: 1,
        resourceUsage: undefined,
      }
    }) as unknown as typeof Bun.spawnSync

    const prevTmux = process.env.TMUX
    const prevTmpDir = process.env.TMUX_TMPDIR
    process.env.TMUX = '/private/tmp/tmux-501/default,1,0'
    process.env.TMUX_TMPDIR = '/tmp/ab-unit-test'
    try {
      timedSpawnSync(['echo', 'hi'])
    } finally {
      bunAny.spawnSync = original
      if (prevTmux === undefined) delete process.env.TMUX
      else process.env.TMUX = prevTmux
      if (prevTmpDir === undefined) delete process.env.TMUX_TMPDIR
      else process.env.TMUX_TMPDIR = prevTmpDir
    }

    // The spawn must see an explicit env — and it must already be isolated:
    // a stale inherited $TMUX (what Workers see) cannot leak through.
    expect(seenEnv).toBeDefined()
    expect(seenEnv!.TMUX).toBeUndefined()
    expect(seenEnv!.TMUX_TMPDIR).toBe('/tmp/ab-unit-test')
  })

  test('timedSpawnSync honours an explicit env override', () => {
    const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
    const original = bunAny.spawnSync
    let seenEnv: Record<string, string | undefined> | undefined
    bunAny.spawnSync = ((command: string[], options?: { env?: Record<string, string | undefined> }) => {
      seenEnv = options?.env
      return {
        exitCode: 0,
        signalCode: null,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        success: true,
        pid: 1,
        resourceUsage: undefined,
      }
    }) as unknown as typeof Bun.spawnSync
    try {
      timedSpawnSync(['echo', 'hi'], { env: { TMUX: '/kept,1,0' } })
    } finally {
      bunAny.spawnSync = original
    }
    expect(seenEnv).toEqual({ TMUX: '/kept,1,0' })
  })
})
