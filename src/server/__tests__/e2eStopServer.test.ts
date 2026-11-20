/**
 * Tests the e2e teardown's server stop (tests/e2e/stopServer.ts) against real
 * child processes standing in for the agentboard server. No tmux is involved.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLockPid, stopE2eServer } from '../../../tests/e2e/stopServer'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-stop-'))
const spawned: Bun.Subprocess[] = []

afterAll(() => {
  for (const proc of spawned) proc.kill('SIGKILL')
  fs.rmSync(root, { recursive: true, force: true })
})

function runDir(name: string, lock?: unknown): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  if (lock !== undefined) {
    fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify(lock))
  }
  return dir
}

// A stand-in server: `trap` decides how it reacts to SIGTERM. It prints once
// the trap is installed so the test never signals it before then.
async function standIn(trap: string): Promise<Bun.Subprocess<'ignore', 'pipe', 'inherit'>> {
  const proc = Bun.spawn(['sh', '-c', `${trap}; echo ready; while :; do sleep 0.05; done`], {
    stdin: 'ignore',
    stdout: 'pipe',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  })
  spawned.push(proc)
  const reader = proc.stdout.getReader()
  await reader.read()
  reader.releaseLock()
  return proc
}

describe('readLockPid', () => {
  test('reads the pid from server.lock', () => {
    expect(readLockPid(runDir('lock-ok', { pid: 4242, port: 1 }))).toBe(4242)
  })

  test('returns null for a missing, malformed, or pid-less lock', () => {
    expect(readLockPid(runDir('lock-missing'))).toBeNull()
    expect(readLockPid(runDir('lock-nopid', { port: 1 }))).toBeNull()
    expect(readLockPid(runDir('lock-badpid', { pid: -3 }))).toBeNull()
    const bad = runDir('lock-bad')
    fs.writeFileSync(path.join(bad, 'server.lock'), '{not json')
    expect(readLockPid(bad)).toBeNull()
  })
})

describe('stopE2eServer', () => {
  test('does nothing without a live lock holder', async () => {
    expect(await stopE2eServer(runDir('none'))).toBe('not-running')
    const exited = Bun.spawnSync(['sh', '-c', 'echo $$'], { env: {} })
    const deadPid = Number.parseInt(exited.stdout.toString(), 10)
    expect(await stopE2eServer(runDir('dead', { pid: deadPid }))).toBe('not-running')
    expect(await stopE2eServer(runDir('self', { pid: process.pid }))).toBe('not-running')
  })

  test('waits for a server that exits on SIGTERM', async () => {
    const proc = await standIn("trap 'sleep 0.3; exit 0' TERM")
    const result = await stopE2eServer(runDir('graceful', { pid: proc.pid }))
    expect(result).toBe('stopped')
    // Resolved only after the process was gone, not when the signal was sent.
    expect(await proc.exited).toBe(0)
  })

  test('SIGKILLs a server that ignores SIGTERM', async () => {
    const proc = await standIn("trap '' TERM")
    const result = await stopE2eServer(runDir('stubborn', { pid: proc.pid }), 200)
    expect(result).toBe('killed')
    expect(proc.signalCode).toBe('SIGKILL')
  })
})
