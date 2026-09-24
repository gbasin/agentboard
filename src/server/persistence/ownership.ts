/** SQLite holds the process lock; the OS releases it on crash or reboot. */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { persistenceDirectory } from './files'

interface Owner {
  db: Database
  token: string
  references: number
}
const owners = new Map<string, Owner>()

function lockPath(dbPath: string) {
  const file = fs.existsSync(dbPath)
    ? fs.realpathSync(dbPath)
    : path.join(
        fs.realpathSync(path.dirname(path.resolve(dbPath))),
        path.basename(dbPath)
      )
  return path.join(persistenceDirectory(file), 'ownership.db')
}

export function acquireDatabaseOwner(dbPath: string) {
  if (dbPath === ':memory:') return { token: '', release() {} }
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), {
    recursive: true,
    mode: 0o700,
  })
  const file = lockPath(dbPath)
  let owner = owners.get(file)
  if (!owner) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const db = new Database(file)
    try {
      fs.chmodSync(file, 0o600)
      db.exec('PRAGMA busy_timeout=1000')
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      db.close()
      if ((error as { code?: string }).code === 'SQLITE_BUSY')
        throw new Error('Another Agentboard process owns this session database')
      throw error
    }
    owner = { db, token: randomUUID(), references: 0 }
    owners.set(file, owner)
  }
  // Multiple connections in the same process share ownership. No test-only bypass.
  owner.references++
  let released = false
  return {
    token: owner.token,
    release() {
      if (released) return
      released = true
      if (--owner.references === 0) {
        owner.db.close()
        owners.delete(file)
      }
    },
  }
}
