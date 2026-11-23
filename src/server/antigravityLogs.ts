// Antigravity CLI writes one trajectory per conversation, alongside full logs and artifacts.
import { Database } from 'bun:sqlite'
import { fileURLToPath } from 'node:url'
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

// Keep the vendor-owned WAL database read-only. Follow atomic replacements and
// let SQLite's data_version invalidate the parent index across connections.
let database: { path: string; ino: number; db: Database; version?: number; children: Map<string, string[]> } | undefined
function summaries() {
  const file = path.join(antigravityHome(), 'conversation_summaries.db')
  const stat = fs.statSync(file)
  if (database?.path !== file || database.ino !== stat.ino) {
    database?.db.close()
    database = undefined
    database = { path: file, ino: stat.ino, db: new Database(file, { readonly: true }), children: new Map() }
  }
  return database
}

interface Conversation { workspace_uris: string; parent_conversation_id: string; agent_name: string }
export function antigravityConversation(id: string) {
  try {
    return summaries().db.query<Conversation, [string]>(
      'SELECT workspace_uris, parent_conversation_id, agent_name FROM conversation_summaries WHERE conversation_id = ?'
    ).get(id)
  } catch { return null }
}

export function antigravityDescendants(log: string, parent: string): string[] {
  if (antigravitySessionId(log) !== parent) return []
  try {
    const catalog = summaries()
    const version = catalog.db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version
    if (version !== catalog.version) {
      const children = new Map<string, string[]>()
      const rows = catalog.db.query<{ conversation_id: string; parent_conversation_id: string }, []>(
        "SELECT conversation_id, parent_conversation_id FROM conversation_summaries WHERE parent_conversation_id != ''"
      ).all()
      for (const row of rows) {
        if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.conversation_id)) continue
        const list = children.get(row.parent_conversation_id) ?? []
        list.push(row.conversation_id)
        children.set(row.parent_conversation_id, list)
      }
      catalog.children = children
      catalog.version = version
    }
    const seen = new Set([parent])
    const queue = [parent], logs: string[] = []
    for (const id of queue) {
      for (const child of catalog.children.get(id) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        queue.push(child)
        logs.push(path.join(antigravityBrain(), child, '.system_generated/logs/transcript.jsonl'))
      }
    }
    return logs
  } catch { return [] }
}

export function isAntigravityAuxiliaryFile(file: string): boolean {
  if (!path.resolve(file).startsWith(path.resolve(antigravityBrain()) + path.sep)) return false
  const id = antigravitySessionId(file)
  return !id || !!antigravityConversation(id)?.parent_conversation_id
}

export function antigravityProjectPath(sessionId: string): string | null {
  const row = antigravityConversation(sessionId)
  if (row) {
    try {
      const uris = JSON.parse(row.workspace_uris)
      return Array.isArray(uris) && uris.length === 1 ? fileURLToPath(uris[0]) : null
    } catch { return null }
  }
  // The cache maps each workspace to its latest ID. Older conversations may be absent.
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(antigravityHome(), 'cache', 'last_conversations.json'), 'utf8'))
    const paths = Object.entries(cache).filter(([workspace, id]) => id === sessionId && path.isAbsolute(workspace))
    return paths.length === 1 ? paths[0]![0] : null
  } catch {
    return null
  }
}
