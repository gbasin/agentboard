// Single-instance guard for the data directory.
//
// Two agentboard servers sharing one data dir is unsafe: the reconcile loop
// treats windows it can't see (e.g. a probe pointed at a different tmux
// socket) as gone, and orphans every claimed session in the shared DB.
// We take a pid-bearing lock file at <dataDir>/server.lock before touching
// anything; a second server on the same dir refuses to start, while an
// isolated instance (different AGENTBOARD_DATA_DIR) locks its own dir and
// proceeds normally.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface InstanceLockInfo {
  pid: number
  port: number
  hostname: string
  startedAt: string
}

export class InstanceLockError extends Error {
  constructor(
    message: string,
    readonly holder: InstanceLockInfo
  ) {
    super(message)
    this.name = 'InstanceLockError'
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readLock(lockPath: string): InstanceLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    if (
      typeof parsed?.pid === 'number' &&
      typeof parsed?.port === 'number' &&
      typeof parsed?.hostname === 'string'
    ) {
      return parsed
    }
  } catch {
    // Missing or malformed file — treated as unlocked.
  }
  return null
}

function lockIsHeld(info: InstanceLockInfo): boolean {
  // A lock bearing our own pid is a reentrant init in this process (test
  // files re-import the entrypoint with cache-busting query strings), not a
  // competing server — servers always run as separate processes.
  if (info.pid === process.pid) return false
  // Hostname differs → lock belongs to another machine sharing the dir (e.g.
  // a mounted volume); a foreign pid can't be signalled anyway. Liveness is
  // only meaningful on this host.
  return info.hostname === os.hostname() && isPidAlive(info.pid)
}

function heldError(dataDir: string, holder: InstanceLockInfo): InstanceLockError {
  return new InstanceLockError(
    `agentboard is already running against ${dataDir} ` +
      `(pid ${holder.pid}, port ${holder.port}, since ${holder.startedAt}). ` +
      'Use a different AGENTBOARD_DATA_DIR for an isolated instance.',
    holder
  )
}

export function acquireInstanceLock(dataDir: string, port: number): void {
  fs.mkdirSync(dataDir, { recursive: true })
  const lockPath = path.join(dataDir, 'server.lock')

  const payload: InstanceLockInfo = {
    pid: process.pid,
    port,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
  }

  const existing = readLock(lockPath)
  if (existing && lockIsHeld(existing)) {
    throw heldError(dataDir, existing)
  }
  // Same-pid or stale lock: a plain overwrite is fine — nobody else is racing
  // us unless the file appeared after our read (handled below via EEXIST).
  if (existing) {
    fs.writeFileSync(lockPath, JSON.stringify(payload))
    return
  }

  // Exclusive-create to claim. If the file appeared between our read and
  // this write, re-check liveness before taking over a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload), { flag: 'wx' })
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const current = readLock(lockPath)
      if (current && lockIsHeld(current)) {
        throw heldError(dataDir, current)
      }
      fs.rmSync(lockPath, { force: true })
    }
  }
  throw new InstanceLockError(
    `Could not claim the instance lock at ${lockPath}`,
    { pid: -1, port, hostname: os.hostname(), startedAt: '' }
  )
}

/** Remove the lock only if we still own it — never clobber another server's. */
export function releaseInstanceLock(dataDir: string): void {
  const lockPath = path.join(dataDir, 'server.lock')
  const existing = readLock(lockPath)
  if (existing && existing.pid === process.pid) {
    fs.rmSync(lockPath, { force: true })
  }
}
