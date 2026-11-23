// Antigravity CLI writes one trajectory per conversation, alongside full logs and artifacts.
import fs from 'node:fs'
import path from 'node:path'

export function antigravityHome(): string {
  return process.env.AGENTBOARD_ANTIGRAVITY_HOME?.trim() ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'antigravity-cli')
}

export function antigravityBrain(): string {
  return path.join(antigravityHome(), 'brain')
}

export function antigravitySessionId(file: string): string | null {
  if (path.basename(file) !== 'transcript.jsonl') return null
  const relative = path.relative(antigravityBrain(), file)
  if (relative.startsWith('..' + path.sep)) return null
  return /^([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/.exec(relative.split(path.sep).join('/'))?.[1] ?? null
}

export function isAntigravityAuxiliaryFile(file: string): boolean {
  return path.resolve(file).startsWith(path.resolve(antigravityBrain()) + path.sep) &&
    !antigravitySessionId(file)
}

export function antigravityProjectPath(sessionId: string): string | null {
  // The cache maps each workspace to its latest ID. Older conversations may be absent.
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(antigravityHome(), 'cache', 'last_conversations.json'), 'utf8'))
    const paths = Object.entries(cache).filter(([workspace, id]) => id === sessionId && path.isAbsolute(workspace))
    return paths.length === 1 ? paths[0]![0] : null
  } catch {
    return null
  }
}
