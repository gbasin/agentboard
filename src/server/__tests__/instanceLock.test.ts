import { describe, expect, test, afterEach } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acquireInstanceLock,
  releaseInstanceLock,
  InstanceLockError,
} from '../instanceLock'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-lock-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true })
  }
})

function lockPath(dir: string) {
  return path.join(dir, 'server.lock')
}

function writeLock(dir: string, pid: number, port = 4040) {
  fs.writeFileSync(
    lockPath(dir),
    JSON.stringify({ pid, port, hostname: os.hostname(), startedAt: new Date().toISOString() })
  )
}

describe('instanceLock', () => {
  test('acquire creates server.lock with pid, port, hostname', () => {
    const dir = makeTmpDir()
    acquireInstanceLock(dir, 4055)
    const info = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
    expect(info.pid).toBe(process.pid)
    expect(info.port).toBe(4055)
    expect(info.hostname).toBe(os.hostname())
  })

  test('acquire throws InstanceLockError when a live pid holds the lock', () => {
    const dir = makeTmpDir()
    // pid 1 (launchd/init) is always alive and not ours to signal → EPERM → alive
    writeLock(dir, 1, 4040)
    expect(() => acquireInstanceLock(dir, 4055)).toThrow(InstanceLockError)
    // The existing lock is left untouched.
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(1)
  })

  test('acquire takes over a stale lock (dead pid)', () => {
    const dir = makeTmpDir()
    // Spawn a process that exits immediately, then reuse its (now-dead) pid.
    const proc = Bun.spawnSync(['/usr/bin/true'])
    writeLock(dir, proc.pid)
    acquireInstanceLock(dir, 4055)
    const info = JSON.parse(fs.readFileSync(lockPath(dir), 'utf8'))
    expect(info.pid).toBe(process.pid)
  })

  test('acquire ignores a lock owned by a different hostname', () => {
    const dir = makeTmpDir()
    fs.writeFileSync(
      lockPath(dir),
      JSON.stringify({ pid: 1, port: 4040, hostname: 'other-host', startedAt: new Date().toISOString() })
    )
    acquireInstanceLock(dir, 4055)
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(process.pid)
  })

  test('re-acquire by the same process is allowed (reentrant init)', () => {
    const dir = makeTmpDir()
    acquireInstanceLock(dir, 4055)
    // Test files re-import the entrypoint in-process — the lock records this
    // pid, so a second acquire must not deadlock us against ourselves.
    acquireInstanceLock(dir, 4056)
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).port).toBe(4056)
  })

  test('release removes our lock; second acquire succeeds after release', () => {
    const dir = makeTmpDir()
    acquireInstanceLock(dir, 4055)
    releaseInstanceLock(dir)
    expect(fs.existsSync(lockPath(dir))).toBe(false)
    acquireInstanceLock(dir, 4056)
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).port).toBe(4056)
  })

  test("release does not remove another process's lock", () => {
    const dir = makeTmpDir()
    writeLock(dir, 1)
    releaseInstanceLock(dir)
    expect(fs.existsSync(lockPath(dir))).toBe(true)
    expect(JSON.parse(fs.readFileSync(lockPath(dir), 'utf8')).pid).toBe(1)
  })

  test('release on a missing lock is a no-op', () => {
    const dir = makeTmpDir()
    expect(() => releaseInstanceLock(dir)).not.toThrow()
  })
})
