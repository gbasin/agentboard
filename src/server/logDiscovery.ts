import path from 'node:path'
import fs from 'node:fs/promises'
import { config } from './config'

export function escapeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-')
}

export async function discoverLogFile(
  projectPath: string,
  baseDir = config.claudeProjectsDir
): Promise<string | null> {
  const escaped = escapeProjectPath(projectPath)
  const directory = path.join(baseDir, escaped)

  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return null
  }

  const jsonlFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.jsonl'))
    .filter((name) => !name.startsWith('agent-'))

  if (jsonlFiles.length === 0) {
    return null
  }

  let latestFile: string | null = null
  let latestMtime = 0

  for (const file of jsonlFiles) {
    const fullPath = path.join(directory, file)
    try {
      const stat = await fs.stat(fullPath)
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs
        latestFile = fullPath
      }
    } catch {
      continue
    }
  }

  return latestFile
}
