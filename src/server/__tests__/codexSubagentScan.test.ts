import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexLinkCacheSize,
  clearCodexLinkCache,
  scanCodexSubagentLinksCached,
} from '../codexSubagentScan'
import { extractCodexSubagentLink } from '../logDiscovery'
import { scanCodexSubagentLinks } from '../subagentLogs'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-codex-scan-'))
  clearCodexLinkCache()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function meta(payload: object, extra = ''): string {
  return JSON.stringify({ type: 'session_meta', payload }) + extra
}

function write(rel: string, content: string): string {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
  return p
}

/** The pre-cache implementation: extractCodexSubagentLink on every file. */
function uncachedScan(dir: string): Array<{ ownId: string; parentId: string | null; logPath: string }> {
  const links: Array<{ ownId: string; parentId: string | null; logPath: string }> = []
  const walk = (d: string): void => {
    let names: fs.Dirent[]
    try {
      names = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of names) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.jsonl')) {
        const link = extractCodexSubagentLink(p)
        if (link) links.push({ ...link, logPath: p })
      }
    }
  }
  walk(dir)
  return links
}

function buildFixtureTree(): void {
  const turn = JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(200) } })
  write('2026/01/01/sub.jsonl', meta({ id: 'sub-1', source: { subagent: 'review' }, parent_thread_id: 'root-1' }, '\n' + turn + '\n'))
  write('2026/01/01/spawn.jsonl', meta({ id: 'gc-1', source: { subagent: { thread_spawn: { parent_thread_id: 'sub-1' } } } }, '\n'))
  write('2026/01/02/fork.jsonl', meta({ id: 'fork-1', source: { subagent: 'x' }, forked_from_id: 'root-2' }, '\n'))
  write('2026/01/02/orphan.jsonl', meta({ id: 'orph-1', source: { subagent: 'review' } }, '\n'))
  write('2026/01/02/cli.jsonl', meta({ id: 'cli-1', source: 'cli', forked_from_id: 'root-1' }, '\n'))
  // First line ~30 KB of multibyte text (real rollouts carry
  // base_instructions; first lines run 13-41 KB).
  write('2026/01/03/big.jsonl', meta({ id: 'big-1', source: { subagent: 'review' }, parent_thread_id: 'root-3', base_instructions: 'é'.repeat(15_000) }, '\n' + turn + '\n'))
  // No trailing newline: the whole head is the first line.
  write('2026/01/03/nonl.jsonl', meta({ id: 'nonl-1', source: { subagent: 'review' }, parent_thread_id: 'root-3' }))
  // First line longer than the 64 KB head: truncated, never parses.
  write('2026/01/03/huge.jsonl', meta({ id: 'huge-1', source: { subagent: 'review' }, parent_thread_id: 'root-3', base_instructions: 'y'.repeat(70_000) }, '\n'))
  // Leading whitespace / CRLF are trimmed like before.
  write('2026/01/04/crlf.jsonl', '  ' + meta({ id: 'crlf-1', source: { subagent: 'review' }, parent_thread_id: 'root-4' }, '\r\n'))
  write('2026/01/04/empty.jsonl', '')
  write('2026/01/04/garbage.jsonl', 'not json\n' + meta({ id: 'late-1', source: { subagent: 'review' } }, '\n'))
  write('2026/01/04/notes.txt', meta({ id: 'txt-1', source: { subagent: 'review' } }, '\n'))
  fs.mkdirSync(path.join(root, '2026/01/05/dir.jsonl'), { recursive: true })
}

describe('scanCodexSubagentLinks (cached)', () => {
  test('matches the uncached per-file extraction on a fixture tree, cold and warm', () => {
    buildFixtureTree()
    const expected = uncachedScan(root)
    expect(expected.map((l) => l.ownId).sort()).toEqual(
      ['big-1', 'crlf-1', 'fork-1', 'gc-1', 'nonl-1', 'orph-1', 'sub-1'].sort()
    )
    expect(scanCodexSubagentLinks(root)).toEqual(expected)
    expect(scanCodexSubagentLinks(root)).toEqual(expected)
  })

  test('warm rebuild opens no unchanged file; reads stay within the 64 KB head', () => {
    buildFixtureTree()
    const openSpy = spyOn(fs, 'openSync')
    const readSpy = spyOn(fs, 'readSync')
    try {
      scanCodexSubagentLinks(root)
      // 11 .jsonl files; notes.txt and the dir named dir.jsonl are not opened.
      expect(openSpy.mock.calls.length).toBe(11)
      for (const call of readSpy.mock.calls) {
        const args = call as unknown[]
        const length = args[3] as number
        const position = args[4] as number
        expect(position).toBe(0)
        expect(length).toBeLessThanOrEqual(64 * 1024)
      }
      openSpy.mockClear()
      readSpy.mockClear()
      scanCodexSubagentLinks(root)
      expect(openSpy.mock.calls.length).toBe(0)
      expect(readSpy.mock.calls.length).toBe(0)
    } finally {
      openSpy.mockRestore()
      readSpy.mockRestore()
    }
  })

  test('re-reads a file whose size changes (first line completed by an append)', () => {
    const full = meta({ id: 'grow-1', source: { subagent: 'review' }, parent_thread_id: 'root-g' }, '\n')
    const p = write('a/grow.jsonl', full.slice(0, 40))
    expect(scanCodexSubagentLinks(root)).toEqual([])
    fs.appendFileSync(p, full.slice(40))
    expect(scanCodexSubagentLinks(root)).toEqual([
      { ownId: 'grow-1', parentId: 'root-g', logPath: p },
    ])
  })

  test('re-reads a same-size file whose mtime changes; same size + mtime stays cached', () => {
    const p = write('a/m.jsonl', meta({ id: 'm-1', source: { subagent: 'review' }, parent_thread_id: 'pa-1' }, '\n'))
    const t0 = new Date('2026-01-01T00:00:00Z')
    fs.utimesSync(p, t0, t0)
    expect(scanCodexSubagentLinks(root)).toEqual([{ ownId: 'm-1', parentId: 'pa-1', logPath: p }])

    // Same length, different parent, mtime restored: the cache key is
    // unchanged, so the cached link is served (rollouts are append-only).
    fs.writeFileSync(p, meta({ id: 'm-1', source: { subagent: 'review' }, parent_thread_id: 'pb-1' }, '\n'))
    fs.utimesSync(p, t0, t0)
    expect(scanCodexSubagentLinks(root)).toEqual([{ ownId: 'm-1', parentId: 'pa-1', logPath: p }])

    const t1 = new Date('2026-01-01T00:00:01Z')
    fs.utimesSync(p, t1, t1)
    expect(scanCodexSubagentLinks(root)).toEqual([{ ownId: 'm-1', parentId: 'pb-1', logPath: p }])
  })

  test('evicts entries for files that disappear', () => {
    const a = write('a/a.jsonl', meta({ id: 'a-1', source: { subagent: 'r' }, parent_thread_id: 'p' }, '\n'))
    write('a/b.jsonl', meta({ id: 'b-1', source: 'cli' }, '\n'))
    scanCodexSubagentLinks(root)
    expect(codexLinkCacheSize()).toBe(2)
    fs.rmSync(a)
    expect(scanCodexSubagentLinks(root)).toEqual([])
    expect(codexLinkCacheSize()).toBe(1)
    expect(scanCodexSubagentLinks(path.join(root, 'missing'))).toEqual([])
    expect(codexLinkCacheSize()).toBe(0)
  })

  test('caps cached entries; uncached files still produce links', () => {
    const a = write('a/a.jsonl', meta({ id: 'a-1', source: { subagent: 'r' }, parent_thread_id: 'p' }, '\n'))
    const b = write('a/b.jsonl', meta({ id: 'b-1', source: { subagent: 'r' }, parent_thread_id: 'p' }, '\n'))
    const expected = uncachedScan(root)
    expect(expected.map((l) => l.logPath).sort()).toEqual([a, b])
    expect(scanCodexSubagentLinksCached(root, 1)).toEqual(expected)
    expect(codexLinkCacheSize()).toBe(1)
    expect(scanCodexSubagentLinksCached(root, 1)).toEqual(expected)
  })
})
