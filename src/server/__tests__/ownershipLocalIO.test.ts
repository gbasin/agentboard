import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLocalOwnershipIO } from '../ownership/localIO'
import type { TimedSpawnResult } from '../syncSpawnTiming'

test('OS adapter uses explicit sanitized env, UTC, bounds and read-only commands', async () => {
  const calls: string[][] = []
  const io = createLocalOwnershipIO({ codexHome: '/codex', claudeHome: '/claude', socket: '/tmp/private-socket',
    execute: async (command, options): Promise<TimedSpawnResult> => {
      calls.push(command)
      expect(options?.timeout).toBe(5000)
      expect(options?.env?.TMUX).toBeUndefined()
      expect(options?.env?.TZ).toBe('UTC')
      expect(options?.env?.LC_ALL).toBe('C')
      return { exitCode: 0, signalCode: null, stderr: '', stdout: command[0] === 'tmux' ? 'ab\t@1\t%1\t42\t99\n'
        : command[0] === 'ps' ? '42 1 Thu Oct 15 20:05:59 2026 claude\n' : 'p42\0\nf8\0aw\0tREG\0n/transcript\0\n' }
    } })
  expect(await io.panes()).toEqual([{ window: 'ab:@1', pane: '%1', pid: 42, serverPid: 99 }])
  expect((await io.processes())[0].pid).toBe(42)
  expect((await io.files([42]))[0].access).toBe('w')
  expect(calls[0].slice(0, 6)).toEqual(['tmux', '-u', '-S', '/tmp/private-socket', 'list-panes', '-a'])
  expect(calls[2]).toEqual(['lsof', '-nP', '-p', '42', '-F0pftan'])
})

test('OS adapter reports command failures and invalid pane rows', async () => {
  const io = createLocalOwnershipIO({ codexHome: '/codex', claudeHome: '/claude', execute: async () => ({ exitCode: null, signalCode: 'SIGTERM', stdout: '', stderr: '' }) })
  await expect(io.processes()).rejects.toThrow('inspection failed')
  const invalid = createLocalOwnershipIO({ codexHome: '/codex', claudeHome: '/claude', execute: async () => ({ exitCode: 0, signalCode: null, stdout: 'bad', stderr: '' }) })
  await expect(invalid.panes()).rejects.toThrow('invalid tmux pane identity')
})

test('head reads are bounded and cache invalidates rewritten metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ab-ownership-'))
  try {
    const file = path.join(root, 'record')
    const io = createLocalOwnershipIO({ codexHome: root, claudeHome: root })
    await writeFile(file, 'initial')
    expect(await io.head(file, true)).toBe('initial')
    await writeFile(file, 'replacement')
    expect(await io.head(file, true)).toBe('replacement')
    await writeFile(file, 'a'.repeat(128 * 1024))
    expect((await io.head(file, false))?.length).toBe(64 * 1024)
    expect(await io.head(root, false)).toBeNull()
    expect(await io.head(path.join(root, 'missing'), false)).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})
