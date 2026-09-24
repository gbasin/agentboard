/** Shared directory for recovery artifacts (ownership lock and friends). */
import path from 'node:path'

export function persistenceDirectory(dbPath: string) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath)}.recovery`)
}
