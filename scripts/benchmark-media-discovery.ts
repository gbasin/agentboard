/** Read-only transcript benchmark; a disposable index keeps production storage untouched. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MediaIndex } from '../src/server/mediaIndex'
import { getSubagentLogPaths } from '../src/server/subagentLogs'
import type { AgentSessionRecord } from '../src/server/db'

const logFilePath = process.argv[2]
if (!logFilePath) throw Error('Usage: bun scripts/benchmark-media-discovery.ts /path/to/claude-session.jsonl')
const record = { sessionId: path.basename(logFilePath, '.jsonl'), logFilePath: path.resolve(logFilePath),
  agentType: 'claude', lastKnownLogSize: null } as AgentSessionRecord
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-media-benchmark-'))
let index: MediaIndex | undefined, reader: MediaIndex | undefined
try {
  index = new MediaIndex(path.join(directory, 'index.sqlite'))
  reader = new MediaIndex(path.join(directory, 'index.sqlite'), { readonly: true })
  const started = performance.now()
  const sources = [record.logFilePath, ...getSubagentLogPaths(record.logFilePath, record.agentType, record.sessionId)]
  const job = index.startScan(record, sources)
  let steps = 0, maxStepMs = 0, maxReadMs = 0, firstPageMs: number | null = null
  while (true) {
    const stepStarted = performance.now(), result = index.stepScan(job)
    maxStepMs = Math.max(maxStepMs, performance.now() - stepStarted); steps++
    const readStarted = performance.now(), page = reader.page(record, undefined, { kind: 'media' })
    maxReadMs = Math.max(maxReadMs, performance.now() - readStarted)
    if (firstPageMs === null && page.items.length) firstPageMs = performance.now() - started
    if (result.done) {
      console.log(JSON.stringify({ files: sources.length, sourceBytes: job.sources.reduce((n, file) => n + file.size, 0),
        firstPageMs, completeMs: performance.now() - started, steps, maxStepMs, maxReadMs,
        items: result.summary.total, images: result.summary.images, links: result.summary.links,
        rssBytes: process.memoryUsage().rss }))
      break
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
} finally { reader?.close(); index?.close(); fs.rmSync(directory, { recursive: true, force: true }) }
