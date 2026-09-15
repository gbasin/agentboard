/** One serving process owns a file database, including during restore/migration. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { persistenceDirectory } from './backups'

function bootIdentity(): string | null {
  try {
    if (process.platform === 'linux')
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    if (process.platform === 'darwin') {
      const result = Bun.spawnSync(['sysctl', '-n', 'kern.bootsessionuuid'], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 1000,
      })
      const value = result.stdout.toString().trim()
      if (result.exitCode === 0 && /^[a-f\d-]{36}$/i.test(value)) return value
    }
  } catch {
    /* PID ownership remains available on other platforms. */
  }
  return null
}

export function acquireDatabaseOwner(dbPath: string) {
  if (dbPath === ':memory:') return { token: '', release() {} }
  const file = path.join(persistenceDirectory(dbPath), 'owner.json')
  const bootId = bootIdentity()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  if (fs.existsSync(file)) {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'))
    // Entry-point unit tests import the server repeatedly in one process.
    if (
      owner.pid === process.pid &&
      (!owner.bootId || owner.bootId === bootId) &&
      process.env.NODE_ENV === 'test'
    )
      return { token: undefined, release() {} }
    let alive = true
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false
    }
    if (owner.bootId && bootId && owner.bootId !== bootId) alive = false
    if (alive)
      throw new Error('Another Agentboard process owns this session database')
    fs.unlinkSync(file)
  }
  const token = randomUUID()
  // Exclusive creation makes simultaneous starts fail before either opens SQLite.
  const temporary = `${file}.${token}.partial`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, bootId }))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    fs.linkSync(temporary, file)
  } finally {
    fs.unlinkSync(temporary)
  }
  const release = () => {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token)
        fs.unlinkSync(file)
    } catch {
      /* already released */
    }
    process.removeListener('exit', release)
  }
  process.once('exit', release)
  return { token, release }
}
