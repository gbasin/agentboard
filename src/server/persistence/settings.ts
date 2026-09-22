/** Local persistence policy. */
import type { SessionDatabase } from '../db'
import type { PersistenceSettings } from '../../shared/persistence'
export const defaultPersistenceSettings: PersistenceSettings = {
  autoResume: false,
  capturePreviews: false,
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
    if (typeof patch[key as keyof PersistenceSettings] !== 'boolean')
      throw new Error(`Invalid ${key}`)
  }
  const next = { ...settings, ...patch }
  db.setAppSetting('persistence_settings', JSON.stringify(next))
  return next
}
