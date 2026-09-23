#!/usr/bin/env bun
// regen-fad-fixtures.ts — regenerate tests/fixtures/fad/expected/*.fad.json
//
// Builds the Devin sessions.db fixture from seeds/devin.sql, compiles
// tools/fad-dump (a dev-only Rust shim over the franken_agent_detection
// crate — https://github.com/Dicklesworthstone/franken_agent_detection),
// and runs it with a scrubbed environment against
// tests/fixtures/fad/home so every connector resolves roots the way the real
// agent CLIs do. Output conversations are grouped by sourcePath and written
// as one expected file per fixture source:
//   expected/<agent>__<relative path under home, '/' -> '__'>.fad.json
//
// Usage: bun run scripts/regen-fad-fixtures.ts
// Requires: cargo (builds tools/fad-dump on demand).

import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureHome = path.join(repoRoot, 'tests', 'fixtures', 'fad', 'home')
const seedsDir = path.join(repoRoot, 'tests', 'fixtures', 'fad', 'seeds')
const expectedDir = path.join(repoRoot, 'tests', 'fixtures', 'fad', 'expected')
const fadDumpDir = path.join(repoRoot, 'tools', 'fad-dump')
const fadDumpBin = path.join(fadDumpDir, 'target', 'release', 'fad-dump')
const devinDbPath = path.join(fixtureHome, '.local', 'share', 'devin', 'cli', 'sessions.db')

/** Expected-file name for a source path under the fixture home. */
export function expectedNameFor(agent: string, sourcePath: string): string {
  const rel = path.relative(fixtureHome, sourcePath)
  return `${agent}__${rel.replace(/[/\\]/g, '__')}.fad.json`
}

function buildDevinFixtureDb(): void {
  fs.mkdirSync(path.dirname(devinDbPath), { recursive: true })
  if (fs.existsSync(devinDbPath)) fs.unlinkSync(devinDbPath)
  const db = new Database(devinDbPath)
  try {
    db.exec(fs.readFileSync(path.join(seedsDir, 'devin.sql'), 'utf8'))
  } finally {
    db.close()
  }
  console.log(`built ${devinDbPath}`)
}

function buildFadDump(): void {
  const result = Bun.spawnSync(['cargo', 'build', '--release'], {
    cwd: fadDumpDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error('cargo build --release failed for tools/fad-dump')
  }
}

interface FadConversation {
  agent: string
  externalId: string | null
  title: string | null
  workspace: string | null
  sourcePath: string
  startedAt: number | null
  endedAt: number | null
  messages: Array<{ idx: number; role: string; content: string; createdAt: number | null }>
  error?: string
}

function runFadDump(): FadConversation[] {
  // Scrubbed env: only HOME + PATH so connector root resolution is driven
  // entirely by the fixture tree — no CLAUDE_CONFIG_DIR/XDG_* leakage from
  // the developer shell.
  const proc = Bun.spawnSync([fadDumpBin], {
    env: { HOME: fixtureHome, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.stderr.length > 0) {
    process.stderr.write(proc.stderr)
  }
  const lines = proc.stdout.toString().split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line) as FadConversation)
}

function main(): void {
  buildDevinFixtureDb()
  buildFadDump()

  const conversations = runFadDump()
  const bySource = new Map<string, FadConversation[]>()
  const errors: FadConversation[] = []
  for (const conv of conversations) {
    if (conv.error) {
      errors.push(conv)
      continue
    }
    const list = bySource.get(conv.sourcePath) ?? []
    list.push(conv)
    bySource.set(conv.sourcePath, list)
  }

  fs.mkdirSync(expectedDir, { recursive: true })
  const written: string[] = []
  for (const [sourcePath, convs] of bySource) {
    if (!sourcePath.startsWith(fixtureHome + path.sep)) {
      console.warn(`skip out-of-tree source: ${sourcePath}`)
      continue
    }
    for (const conv of convs) {
      const name = expectedNameFor(conv.agent, sourcePath)
      const outPath = path.join(expectedDir, name)
      fs.writeFileSync(outPath, JSON.stringify(conv, null, 2) + '\n')
      written.push(name)
    }
  }

  // Remove stale expected files no longer produced.
  for (const entry of fs.readdirSync(expectedDir)) {
    if (entry.endsWith('.fad.json') && !written.includes(entry)) {
      fs.unlinkSync(path.join(expectedDir, entry))
      console.log(`removed stale ${entry}`)
    }
  }

  console.log(`wrote ${written.length} expected file(s)`)
  for (const err of errors) {
    console.warn(`connector ${err.agent} failed: ${err.error}`)
  }
}

main()
