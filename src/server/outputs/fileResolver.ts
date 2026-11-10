/** Session-scoped evidence cache. Only unique, existing matches may resolve a bare filename. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { getSubagentLogPaths } from '../subagentLogs'
import { resolveWorkerPath } from '../workerPath'
import { sanitizedTmuxEnv } from '../tmuxEnv'
import type { AgentSessionRecord } from '../db'
import { absoluteOutputPath } from './fileEvidence'

type Session = Pick<AgentSessionRecord, 'sessionId' | 'agentType' | 'logFilePath' | 'projectPath'>
export type FileResolution = { kind: 'resolved'; file: string } | { kind: 'missing'; attemptedPath: string } | { kind: 'ambiguous'; candidates: string[] }
async function isFile(file: string) {
  try { return (await fs.stat(file)).isFile() } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

export class OutputFileResolver {
  private cache = new Map<string, { signature: string; paths: Promise<string[]> }>()
  private active = 0
  private async evidence(record: Session): Promise<string[]> {
    const sourceFiles = () => [record.logFilePath!, ...getSubagentLogPaths(record.logFilePath!, record.agentType, record.sessionId)]
    const files = sourceFiles()
    const snapshot = (sources: string[]) => Promise.all(sources.map(async file => {
      try { const s = await fs.stat(file); return [file, s.ino, s.size, s.mtimeMs, s.ctimeMs] }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null]; throw error }
    }))
    const stamps = await snapshot(files)
    const key = JSON.stringify([record.sessionId, record.logFilePath, record.agentType, record.projectPath])
    const signature = JSON.stringify(stamps)
    const cached = this.cache.get(key)
    if (cached?.signature === signature) return cached.paths
    if (this.active >= 2) throw Error('File lookup is busy. Try again in a moment.')
    this.active++
    const paths = new Promise<string[]>((resolve, reject) => {
      const worker = new Worker(resolveWorkerPath('outputPathWorker'), { type: 'module', env: sanitizedTmuxEnv() })
      worker.onmessage = (event: MessageEvent<{ paths: string[] } | { error: string }>) => {
        if ('error' in event.data) reject(Error(event.data.error))
        else resolve(event.data.paths)
      }
      worker.onerror = () => reject(Error('Unable to read session file references. Try again.'))
      worker.onmessageerror = () => reject(Error('Unable to read session file references. Try again.'))
      worker.postMessage({ files, cwd: record.projectPath })
    }).then(async result => {
      if (JSON.stringify(await snapshot(sourceFiles())) !== signature) {
        throw Error('Session files changed during lookup. Try again to use the latest references.')
      }
      return result
    }).finally(() => { this.active-- })
    const entry = { signature, paths }
    this.cache.delete(key)
    this.cache.set(key, entry)
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!)
    try { return await paths } catch (error) { if (this.cache.get(key) === entry) this.cache.delete(key); throw error }
  }

  async resolve(ref: string, record: Session, selected?: string): Promise<FileResolution> {
    const attemptedPath = absoluteOutputPath(ref, record.projectPath)
    // Explicit paths never silently fall back to another directory.
    const bare = path.basename(ref) === ref
    if (!selected && await isFile(attemptedPath)) return { kind: 'resolved', file: attemptedPath }
    if (!bare || !record.logFilePath) return { kind: 'missing', attemptedPath }
    const evidence = await this.evidence(record)
    const matches = evidence.filter(file => path.basename(file) === ref)
    const existing = (await Promise.all(matches.map(async file => await isFile(file) ? file : null))).filter((file): file is string => file !== null).sort()
    // A choice is accepted only while still present in this session's current evidence.
    if (selected) {
      if (!existing.includes(selected)) throw Error('That file is no longer a matching session output. Reload the preview.')
      return { kind: 'resolved', file: selected }
    }
    if (existing.length === 1) return { kind: 'resolved', file: existing[0] }
    return existing.length ? { kind: 'ambiguous', candidates: existing } : { kind: 'missing', attemptedPath }
  }
}
