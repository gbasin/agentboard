// WAL-reset coverage for devinDbFingerprint: after a checkpoint restarts the
// WAL, later commits overwrite frames inside the old WAL size, so only the
// -shm WAL-index header changes deterministically.
import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { devinDbFingerprint } from '../devinDbFingerprint'
import { syncDevinSessions } from '../devinSync'
import {
  addMessage,
  addSession,
  createDevinDb,
  paths,
  readLines,
  useDevinSyncFixture,
} from './devinSyncFixture'

useDevinSyncFixture()

function parts(fingerprint: string) {
  const [db, wal, shm] = fingerprint.split('|')
  const [, walSize, , walHeader] = wal.slice('wal='.length).split(':')
  return { db, walSize, walHeader, shm }
}

describe('devinDbFingerprint', () => {
  test('changes on a commit after WAL reset even when WAL size/header do not', () => {
    const db = createDevinDb()
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = -1')
      addSession(db, 'r', '/p', null)
      for (let i = 0; i < 20; i++) addMessage(db, 'r', 'user', `bulk ${i} ${'x'.repeat(3000)}`)
      db.exec('PRAGMA wal_checkpoint(RESTART)')

      addMessage(db, 'r', 'assistant', 'commit A')
      const afterA = devinDbFingerprint(paths.dbPath)
      expect(syncDevinSessions(paths.outDir)?.rewritten).toBe(1)

      addMessage(db, 'r', 'assistant', 'commit B')
      const afterB = devinDbFingerprint(paths.dbPath)

      // The WAL alone cannot tell A from B (mtime aside, which is coarse on
      // Linux): same size, same header. The -shm header must differ.
      expect(parts(afterB).walSize).toBe(parts(afterA).walSize)
      expect(parts(afterB).walHeader).toBe(parts(afterA).walHeader)
      expect(parts(afterB).shm).not.toBe(parts(afterA).shm)
      expect(afterB).not.toBe(afterA)

      expect(syncDevinSessions(paths.outDir)?.appended).toBe(1)
      const last = readLines(path.join(paths.outDir, 'r.jsonl')).at(-1)
      expect((last?.message as { content: string }).content).toBe('commit B')
    } finally {
      db.close()
    }
  })

  test('a reader does not perturb the fingerprint', () => {
    const db = createDevinDb()
    try {
      db.exec('PRAGMA journal_mode = WAL')
      addSession(db, 'q', '/p', null)
      addMessage(db, 'q', 'user', 'hi')
      const before = devinDbFingerprint(paths.dbPath)
      syncDevinSessions(paths.outDir) // opens a readonly connection
      expect(devinDbFingerprint(paths.dbPath)).toBe(before)
    } finally {
      db.close()
    }
  })
})
