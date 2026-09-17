/** Local persistence policy; metadata retention is independent of content budgets. */
import type { SessionDatabase } from '../db'
import type { PersistenceSettings } from '../../shared/persistence'
export const defaultPersistenceSettings: PersistenceSettings = {
  autoResume: false,
  archiveEnabled: true,
  archiveMaxBytes: 512 * 1024 * 1024,
  capturePreviews: false,
  backupHourly: 24,
  backupDaily: 30,
  backupMonthly: 12,
}
export function getPersistenceSettings(
  db: SessionDatabase
): PersistenceSettings {
  try {
    return {
      ...defaultPersistenceSettings,
      ...JSON.parse(db.getAppSetting('persistence_settings') || '{}'),
    }
  } catch {
    return { ...defaultPersistenceSettings }
  }
}
export function savePersistenceSettings(
  db: SessionDatabase,
  patch: Partial<PersistenceSettings>
) {
  const settings = getPersistenceSettings(db)
  for (const key of Object.keys(patch)) {
    if (!(key in settings)) throw new Error(`Unknown setting: ${key}`)
    const value = patch[key as keyof PersistenceSettings]
    if (typeof settings[key as keyof PersistenceSettings] === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`)
    } else if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > (key === 'archiveMaxBytes' ? 100 * 1024 ** 3 : 365)
    )
      throw new Error(`Invalid ${key}`)
  }
  const next = { ...settings, ...patch }
  db.setAppSetting('persistence_settings', JSON.stringify(next))
  return next
}
