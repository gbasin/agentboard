import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  deriveDisplayName,
  getCachedMedia,
  getMergedMedia,
  rescanMedia,
  toAgentSession,
} from '../agentSessions'
import { clearMediaScanCache } from '../mediaExtractor'
import { clearSubagentLogCaches } from '../subagentLogs'
import type { AgentSessionRecord } from '../db'

const baseRecord: AgentSessionRecord = {
  id: 1,
  sessionId: 'session-12345678-abcdef',
  logFilePath: '/tmp/session.jsonl',
  projectPath: '/projects/alpha',
  slug: null,
  agentType: 'claude',
  displayName: 'Alpha Project',
  createdAt: '2024-01-01T00:00:00.000Z',
  lastActivityAt: '2024-01-02T00:00:00.000Z',
  lastUserMessage: null,
  currentWindow: 'agentboard:1',
  isHibernating: false,
  lastResumeError: null,
  wakeStartedAt: null,
  lastKnownLogSize: null,
  isCodexExec: false,
  launchCommand: null,
}

describe('agentSessions', () => {
  test('toAgentSession maps record and active state', () => {
    const active = toAgentSession(baseRecord)
    expect(active.sessionId).toBe(baseRecord.sessionId)
    expect(active.isActive).toBe(true)

    const inactive = toAgentSession({ ...baseRecord, currentWindow: null })
    expect(inactive.isActive).toBe(false)
  })

  test('deriveDisplayName uses fallback, leaf, and session id', () => {
    expect(deriveDisplayName('/projects/alpha', 'session-12345678', '  custom  ')).toBe(
      'custom'
    )
    expect(deriveDisplayName('/projects/alpha', 'session-12345678')).toBe('alpha')
    expect(deriveDisplayName('', 'session-12345678')).toBe('session-')
  })
})

describe('session media', () => {
  let dir: string
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhHGAfKmMIwAAAABJRU5ErkJggg=='

  const imageLine = () =>
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: PNG_B64 },
          },
        ],
      },
    })

  const recordFor = (logFilePath: string): AgentSessionRecord => ({
    ...baseRecord,
    logFilePath,
    currentWindow: null,
  })

  beforeEach(() => {
    clearMediaScanCache()
    clearSubagentLogCaches()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sessions-media-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('toAgentSession stamps media descriptors with endpoint urls', () => {
    const logPath = path.join(dir, 'session.jsonl')
    fs.writeFileSync(logPath, imageLine() + '\n')

    const session = toAgentSession(recordFor(logPath))
    expect(session.media).toHaveLength(1)
    const m = session.media![0]
    expect(m.kind).toBe('image')
    expect(m.mediaType).toBe('image/png')
    expect(m.url).toContain('/api/session-media/session-12345678-abcdef')
    expect(m.url).toContain(`path=${encodeURIComponent(logPath)}`)
    expect(m.url).toContain('offset=0')
    expect(m.url).toContain('index=0')
  })

  test('media merges the main log and claude subagent logs', () => {
    const logPath = path.join(dir, 'parent.jsonl')
    const subDir = path.join(dir, 'parent', 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(logPath, imageLine() + '\n')
    const subPath = path.join(subDir, 'child.jsonl')
    fs.writeFileSync(subPath, imageLine() + '\n')

    const media = getMergedMedia(recordFor(logPath))
    expect(media).toHaveLength(2)
    expect(media.map((m) => decodeURIComponent(m.url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(logPath),
        expect.stringContaining(subPath),
      ])
    )
  })

  test('cached path returns the last scan without touching the log', () => {
    const logPath = path.join(dir, 'cached.jsonl')
    fs.writeFileSync(logPath, imageLine() + '\n')
    const record = recordFor(logPath)

    rescanMedia(record)
    expect(getCachedMedia(record)).toHaveLength(1)
    expect(toAgentSession(record, { cachedPrsOnly: true }).media).toHaveLength(1)

    // Deleting the log can't drop a dormant session's cached media.
    fs.rmSync(logPath)
    expect(toAgentSession(record, { cachedPrsOnly: true }).media).toHaveLength(1)
  })
})
