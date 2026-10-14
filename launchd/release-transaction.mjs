// Journal the service replacement before stopping anything. All paths are local.
import fs from 'node:fs'
import path from 'node:path'
import { atomicWrite } from './release-store.mjs'

export async function restore(base, service) {
  const file = path.join(base, 'release-pending.json')
  if (!fs.existsSync(file)) return false
  const previous = JSON.parse(fs.readFileSync(file, 'utf8'))
  await service.stop()
  if (previous.plist === null) fs.rmSync(service.plist, { force: true })
  else atomicWrite(service.plist, previous.plist)
  if (previous.loaded) {
    await service.start()
    if (previous.healthy) await service.checkPrevious()
    else console.warn('Previous configuration restored; the previous service was not verified healthy before this upgrade.')
  }
  service.setDisabled(previous.disabled)
  fs.unlinkSync(file)
  return true
}

export async function activate(base, service, plist, release) {
  const journal = path.join(base, 'release-pending.json')
  if (fs.existsSync(journal)) throw new Error('An interrupted upgrade needs recovery first')
  service.assertManaged()
  const previous = {
    plist: fs.existsSync(service.plist) ? fs.readFileSync(service.plist, 'utf8') : null,
    loaded: service.loaded(),
    disabled: service.disabled(),
  }
  if (previous.loaded && previous.plist === null) {
    throw new Error('Loaded service has no plist to restore; save its configuration first')
  }
  previous.healthy = previous.loaded && await service.wasHealthy()
  atomicWrite(journal, JSON.stringify(previous))
  try {
    await service.stop()
    await service.assertPortFree()
    atomicWrite(service.plist, plist)
    await service.start()
    await service.check(release)
    // Removing the journal commits the transaction. A crash before this is recoverable.
    fs.unlinkSync(journal)
  } catch (error) {
    try {
      await restore(base, service)
    } catch (rollbackError) {
      throw new Error(`Upgrade failed: ${error.message}\nRecovery also failed: ${rollbackError.message}\n` +
        `Previous configuration is preserved in ${journal}. Run install.sh --release --recover.`,
      { cause: error })
    }
    throw new Error(`Upgrade failed; previous service configuration restored: ${error.message}`, { cause: error })
  }
}

export function lock(base) {
  const dir = path.join(base, 'release-install.lock')
  try { fs.mkdirSync(dir, { mode: 0o700 }) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Another installer may be running. If it was interrupted, verify its PID in ${dir}/pid, ` +
      'then remove that lock directory and run install.sh --release --recover.')
  }
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid))
  return () => fs.rmSync(dir, { recursive: true, force: true })
}
