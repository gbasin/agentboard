/** Offline recovery and export without starting tmux or any agent processes. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import {
  SessionBackups,
  applyPendingRestore,
  verifyBackup,
  publishFile,
} from '../src/server/persistence/backups'
import { acquireDatabaseOwner } from '../src/server/persistence/ownership'
import { importRecoveryExport } from '../src/server/persistence/importExport'

const args = process.argv.slice(2)
const dbFlag = args.indexOf('--db')
const file = path.resolve(
  dbFlag >= 0
    ? args.splice(dbFlag, 2)[1]
    : process.env.AGENTBOARD_DB_PATH ||
        path.join(os.homedir(), '.agentboard', 'agentboard.db')
)
const [command, value] = args
if (
  ![
    'backups',
    'backup',
    'restore',
    'apply-restore',
    'export',
    'import',
  ].includes(command)
) {
  console.log(`Usage: bun run history <command> [--db /path/agentboard.db]

  backups                 List database recovery points
  backup                  Create a verified database snapshot
  restore BACKUP_NAME      Schedule restoration for the next server start
  apply-restore           Apply a scheduled restore while Agentboard is stopped
  export NEW_DIRECTORY    Export a database and its archived conversation logs
  import DIRECTORY        Verify an export and schedule restoration on restart

Exports contain private session data. Provider attachments are not included.
Restoration preserves the current database first and never starts agents.`)
  process.exit(command ? 1 : 0)
}
if (!fs.existsSync(file)) throw new Error(`Database not found: ${file}`)
if (command === 'apply-restore') {
  const owner = acquireDatabaseOwner(file)
  try {
    applyPendingRestore(file, owner.token)
    console.log('Restore request applied, if one was pending.')
  } finally {
    owner.release()
  }
} else {
  const db = new Database(file)
  try {
    const backups = new SessionBackups(db, file)
    if (command === 'backups')
      console.log(JSON.stringify(backups.list(), null, 2))
    if (command === 'backup')
      console.log(backups.resolve(backups.create().name))
    if (command === 'import') {
      if (!value) throw new Error('Provide a recovery export directory')
      const backup = await importRecoveryExport(backups, path.resolve(value))
      backups.scheduleRestore(backup.name)
      console.log(
        'Export verified and restore scheduled. Restart Agentboard to apply it.'
      )
    }
    if (command === 'restore') {
      if (!value)
        throw new Error('Provide a backup name from the backups command')
      backups.scheduleRestore(value)
      console.log(
        'Restore scheduled. Restart Agentboard or stop it and run apply-restore.'
      )
    }
    if (command === 'export') {
      if (!value) throw new Error('Provide a new destination directory')
      const destination = path.resolve(value)
      fs.mkdirSync(destination, { mode: 0o700 })
      const backup = backups.create('export'),
        source = backups.resolve(backup.name)
      const exported = path.join(destination, 'agentboard.db')
      fs.copyFileSync(source, `${exported}.partial`, fs.constants.COPYFILE_EXCL)
      verifyBackup(`${exported}.partial`)
      publishFile(`${exported}.partial`, exported)
      const snapshot = new Database(exported, { readonly: true })
      try {
        const manifest: {
          providerId: string
          file: string
          checksum: string
          complete: boolean
        }[] = []
        if (
          snapshot
            .query("SELECT 1 FROM sqlite_master WHERE name='session_archives'")
            .get()
        ) {
          const rows = snapshot
            .query(
              'SELECT provider_id,archive_path,checksum,complete FROM session_archives'
            )
            .all() as {
            provider_id: string
            archive_path: string
            checksum: string
            complete: number
          }[]
          for (const row of rows) {
            const name = path.basename(row.archive_path)
            const hasher = createHash('sha256')
            for await (const chunk of fs.createReadStream(row.archive_path))
              hasher.update(chunk)
            const hash = hasher.digest('hex')
            if (hash !== row.checksum)
              throw new Error(`Archive failed verification: ${row.provider_id}`)
            fs.copyFileSync(
              row.archive_path,
              path.join(destination, `${name}.partial`),
              fs.constants.COPYFILE_EXCL
            )
            publishFile(
              path.join(destination, `${name}.partial`),
              path.join(destination, name)
            )
            manifest.push({
              providerId: row.provider_id,
              file: name,
              checksum: row.checksum,
              complete: Boolean(row.complete),
            })
          }
        }
        fs.writeFileSync(
          path.join(destination, 'manifest.json.partial'),
          JSON.stringify(
            {
              database: 'agentboard.db',
              createdAt: new Date().toISOString(),
              conversations: manifest,
            },
            null,
            2
          ),
          { mode: 0o600, flag: 'wx' }
        )
        publishFile(
          path.join(destination, 'manifest.json.partial'),
          path.join(destination, 'manifest.json')
        )
      } finally {
        snapshot.close()
      }
      console.log(destination)
    }
  } finally {
    db.close()
  }
}
