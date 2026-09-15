import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { SessionCatalog } from '../persistence/catalog'
import { ConversationIndexer } from '../persistence/indexer'
import { ConversationArchives } from '../persistence/archives'
import {
  SessionBackups,
  applyPendingRestore,
  verifyBackup,
} from '../persistence/backups'
import { defaultPersistenceSettings } from '../persistence/settings'
import { Database } from 'bun:sqlite'
import { acquireDatabaseOwner } from '../persistence/ownership'
import { importRecoveryExport } from '../persistence/importExport'

const roots: string[] = [],
  dbs: SessionDatabase[] = []
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-storage-'))
  roots.push(root)
  const file = path.join(root, 'agentboard.db'),
    db = initDatabase({ path: file })
  dbs.push(db)
  const catalog = new SessionCatalog(db.db, 'host')
  return { root, file, db, catalog }
}
afterEach(() => {
  for (const db of dbs.splice(0))
    try {
      db.close()
    } catch {}
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true })
})
function log(root: string, id: string, source: unknown = 'cli') {
  const dir = path.join(root, '.codex', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'session_meta',
      timestamp: '2020-01-01T00:00:00.000Z',
      payload: { id, cwd: root, source },
    }) +
      '\n' +
      JSON.stringify({
        type: 'response_item',
        timestamp: '2020-01-01T01:00:00.000Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Old task ${id}` }],
        },
      }) +
      '\n'
  )
  return file
}
describe('complete conversation discovery', () => {
  test('indexes beyond 25 files without a matcher and keeps the queue across reopen', async () => {
    const { root, db, catalog } = setup()
    const paths = Array.from({ length: 35 }, (_, i) => log(root, `root-${i}`))
    paths.push(
      ...Array.from({ length: 30 }, (_, i) =>
        log(root, `sub-${i}`, { subagent: 'review' })
      )
    )
    let indexer = new ConversationIndexer(db, catalog, () => paths)
    await indexer.tick(true)
    indexer = new ConversationIndexer(db, catalog, () => paths)
    for (let i = 0; i < 4; i++) await indexer.tick()
    expect(indexer.pending).toBe(0)
    expect(db.getKnownSessionKeys()).toHaveLength(35)
    expect(catalog.history({ limit: 100 }).sessions).toHaveLength(35)
    expect(catalog.history({ q: 'Old task root-34' }).sessions).toHaveLength(1)
  })
  test('a malformed file is retried without losing valid entries', async () => {
    const { root, db, catalog } = setup()
    const good = log(root, 'good'),
      bad = log(root, 'bad')
    fs.writeFileSync(bad, '{"partial":')
    const indexer = new ConversationIndexer(db, catalog, () => [bad, good])
    await indexer.tick(true)
    expect(db.getSessionById('good')).not.toBeNull()
    expect(indexer.pending).toBe(1)
    log(root, 'bad')
    await indexer.tick(true)
    expect(db.getSessionById('bad')).not.toBeNull()
    expect(indexer.pending).toBe(0)
  })
})
describe('verified backups and archives', () => {
  test('a portable export verifies and restores metadata plus relocated conversation copies', async () => {
    const { root, file, db, catalog } = setup(),
      source = log(root, 'portable')
    await new ConversationIndexer(db, catalog, () => [source]).tick(true)
    const record = db.getSessionById('portable')!
    await new ConversationArchives(db, file).archive(record, 1000000)
    const exported = path.join(root, 'export')
    const process = Bun.spawn(
      ['bun', 'scripts/session-history.ts', 'export', exported, '--db', file],
      { stdout: 'pipe', stderr: 'pipe' }
    )
    expect(await process.exited).toBe(0)
    const target = setup(),
      backups = new SessionBackups(target.db.db, target.file)
    const imported = await importRecoveryExport(backups, exported)
    backups.scheduleRestore(imported.name)
    target.db.close()
    applyPendingRestore(target.file)
    const restored = initDatabase({ path: target.file })
    dbs.push(restored)
    const restoredCatalog = new SessionCatalog(restored.db, 'host')
    expect(restoredCatalog.byProvider(record.sessionId)?.name).toBe(
      catalog.byProvider(record.sessionId)?.name
    )
    const restoredArchive = await new ConversationArchives(
      restored,
      target.file
    ).verify(record.sessionId)
    expect(restoredArchive.archive_path.startsWith(target.root)).toBe(true)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(exported, 'manifest.json'), 'utf8')
    )
    fs.appendFileSync(
      path.join(exported, manifest.conversations[0].file),
      'bad'
    )
    const before = backups.list().length
    await expect(importRecoveryExport(backups, exported)).rejects.toThrow(
      'verification'
    )
    expect(backups.list()).toHaveLength(before)
    expect(
      fs.readdirSync(backups.directory).some((n) => n.endsWith('.partial'))
    ).toBe(false)
  })
  test('backup preserves a consistent catalog and restores only after restart', () => {
    const { file, db, catalog } = setup()
    const saved = catalog.create({
      name: 'A',
      projectPath: '/project',
      command: 'sh',
    })
    const backups = new SessionBackups(db.db, file),
      backup = backups.create()
    catalog.rename(saved.id, 'Renamed')
    backups.scheduleRestore(backup.name)
    expect(catalog.get(saved.id)?.name).toBe('Renamed')
    db.close()
    applyPendingRestore(file)
    const restored = initDatabase({ path: file })
    dbs.push(restored)
    expect(new SessionCatalog(restored.db, 'host').get(saved.id)?.name).toBe(
      'A'
    )
    expect(
      new SessionBackups(restored.db, file)
        .list()
        .some((b) => b.name.includes('before-restore'))
    ).toBe(true)
  })
  test('invalid backups and traversal never replace the current database', () => {
    const { file, db, catalog, root } = setup()
    catalog.create({ name: 'A', projectPath: root, command: 'sh' })
    const backups = new SessionBackups(db.db, file)
    expect(() => backups.resolve('../agentboard.db')).toThrow('not found')
    const bad = path.join(root, 'bad.db')
    fs.writeFileSync(bad, 'broken')
    expect(() => verifyBackup(bad)).toThrow()
    expect(catalog.history().sessions).toHaveLength(1)
  })
  test('archive stays readable when source disappears and supports verified restoration', async () => {
    const { file, root, db, catalog } = setup()
    const source = log(root, 'archive-me')
    const indexer = new ConversationIndexer(db, catalog, () => [source])
    await indexer.tick(true)
    const archives = new ConversationArchives(db, file),
      record = db.getSessionById('archive-me')!
    await archives.archive(record, 1000000)
    const expected = fs.readFileSync(source, 'utf8')
    fs.unlinkSync(source)
    expect(archives.info(record.sessionId)?.sourceMissing).toBe(true)
    await archives.restoreSource(record.sessionId)
    expect(fs.readFileSync(source, 'utf8')).toBe(expected)
    fs.appendFileSync(archives.pathFor(record.sessionId)!, 'corrupted')
    expect(archives.verify(record.sessionId)).rejects.toThrow('verification')
  })
  test('partial JSONL writes preserve only complete records and respect storage budgets', async () => {
    const { file, root, db, catalog } = setup()
    const source = log(root, 'partial')
    const indexer = new ConversationIndexer(db, catalog, () => [source])
    await indexer.tick(true)
    fs.appendFileSync(source, '{"unfinished":')
    const archives = new ConversationArchives(db, file),
      record = db.getSessionById('partial')!
    await archives.archive(record, 1000000)
    expect(archives.info(record.sessionId)?.complete).toBe(false)
    expect(
      fs
        .readFileSync(archives.pathFor(record.sessionId)!, 'utf8')
        .endsWith('\n')
    ).toBe(true)
    const other = log(root, 'too-large')
    await indexer.tick(true) // enqueue explicitly for this new path
    indexer.enqueue([other])
    await indexer.tick()
    expect(
      archives.archive(db.getSessionById('too-large')!, 1)
    ).rejects.toThrow('budget')
  })
  test('rotation retains manual recovery points', () => {
    const { db, file } = setup()
    const backups = new SessionBackups(db.db, file)
    const existing = backups.list().map((b) => b.name),
      manual = backups.create()
    backups.create('automatic')
    backups.rotate(defaultPersistenceSettings, Date.now() + 400 * 86400000)
    expect(
      backups
        .list()
        .map((b) => b.name)
        .sort()
    ).toEqual([...existing, manual.name].sort())
  })
  test('old backup archive references survive append and truncated sources cannot replace them', async () => {
    const { db, file, root, catalog } = setup(),
      source = log(root, 'versioned')
    const indexer = new ConversationIndexer(db, catalog, () => [source])
    await indexer.tick(true)
    const record = db.getSessionById('versioned')!,
      archives = new ConversationArchives(db, file)
    await archives.archive(record, 1000000)
    const first = archives.row(record.sessionId)!
    new SessionBackups(db.db, file).create()
    fs.appendFileSync(
      source,
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'task_complete' },
      }) + '\n'
    )
    await archives.archive(record, 1000000)
    expect(archives.row(record.sessionId)?.archive_path).not.toBe(
      first.archive_path
    )
    expect(fs.existsSync(first.archive_path)).toBe(true)
    expect(await archives.verify(record.sessionId)).toBeTruthy()
    fs.truncateSync(source, 1)
    await expect(archives.archive(record, 1000000)).rejects.toThrow('truncated')
    expect(archives.info(record.sessionId)?.bytes).toBeGreaterThan(first.bytes)
  })
  test('failed backup publication preserves the prior verified recovery point', () => {
    const { db, file } = setup(),
      backups = new SessionBackups(db.db, file),
      good = backups.create()
    db.db.exec('BEGIN')
    try {
      expect(() => backups.create()).toThrow()
    } finally {
      db.db.exec('ROLLBACK')
    }
    expect(backups.error).not.toBeNull()
    expect(() => verifyBackup(backups.resolve(good.name))).not.toThrow()
    expect(
      fs
        .readdirSync(backups.directory)
        .some((name) => name.endsWith('.partial'))
    ).toBe(false)
  })
  test('failed lifecycle writes roll back instead of reporting a saved launch', () => {
    const { db, catalog } = setup(),
      saved = catalog.create({
        name: 'A',
        projectPath: '/project',
        command: 'sh',
      })
    // Simulate SQLite's disk-full failure on the durable event write.
    db.db.exec(
      "CREATE TEMP TRIGGER fail_events BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END"
    )
    expect(() => catalog.beginRun(saved.id)).toThrow('disk is full')
    expect(catalog.get(saved.id)?.state).toBe('interrupted')
    expect(db.db.query('SELECT count(*) AS n FROM session_runs').get()).toEqual(
      { n: 0 }
    )
  })
  test('lock contention cannot partially commit a rename and repeated migrations preserve data', () => {
    const { db, file, catalog } = setup(),
      saved = catalog.create({
        name: 'A',
        projectPath: '/project',
        command: 'sh',
        pinned: true,
      })
    const other = new Database(file)
    try {
      db.db.exec('PRAGMA busy_timeout=1')
      other.exec('BEGIN IMMEDIATE')
      expect(() => catalog.rename(saved.id, 'B')).toThrow()
      other.exec('ROLLBACK')
      expect(new SessionCatalog(db.db, 'host').get(saved.id)?.name).toBe('A')
      expect(new SessionCatalog(db.db, 'host').get(saved.id)?.pinned).toBe(true)
    } finally {
      other.close()
    }
  })
  test('a restore request cannot replace a database owned by a serving process', () => {
    const { db, file } = setup(),
      backups = new SessionBackups(db.db, file)
    backups.scheduleRestore(backups.create().name)
    const owner = acquireDatabaseOwner(file)
    try {
      expect(() => applyPendingRestore(file)).toThrow(
        'Stop the running Agentboard'
      )
    } finally {
      owner.release()
    }
  })
})
