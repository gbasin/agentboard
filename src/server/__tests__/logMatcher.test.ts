import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Session } from '../../shared/types'
import {
  computeSimilarityWithMode,
  findMatchingWindow,
  normalizeText,
} from '../logMatcher'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync

const tmuxOutputs = new Map<string, string>()

function setTmuxOutput(target: string, content: string) {
  tmuxOutputs.set(target, content)
}

beforeEach(() => {
  bunAny.spawnSync = ((args: string[]) => {
    if (args[0] === 'tmux' && args[1] === 'capture-pane') {
      const targetIndex = args.indexOf('-t')
      const target = targetIndex >= 0 ? args[targetIndex + 1] : ''
      const output = tmuxOutputs.get(target ?? '') ?? ''
      return {
        exitCode: 0,
        stdout: Buffer.from(output),
        stderr: Buffer.from(''),
      } as ReturnType<typeof Bun.spawnSync>
    }
    return {
      exitCode: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
    } as ReturnType<typeof Bun.spawnSync>
  }) as typeof Bun.spawnSync
})

afterEach(() => {
  bunAny.spawnSync = originalSpawnSync
  tmuxOutputs.clear()
})

describe('logMatcher', () => {
  test('normalizeText strips ANSI and control characters', () => {
    const input = '\u001b[31mHello\u001b[0m\u0007\nWorld'
    expect(normalizeText(input)).toBe('hello world')
  })

  test('computeSimilarityWithMode returns 0 when below min tokens', () => {
    const score = computeSimilarityWithMode('short text', 'short text', { minTokens: 10 })
    expect(score).toBe(0)
  })

  test('findMatchingWindow selects best match when gap is sufficient', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    const tokens = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ')
    const logLines = [
      JSON.stringify({ type: 'user', content: tokens }),
      JSON.stringify({ type: 'assistant', content: tokens }),
    ]
    await fs.writeFile(logPath, logLines.join('\n'))

    const windows: Session[] = [
      {
        id: 'window-1',
        name: 'alpha',
        tmuxWindow: 'agentboard:1',
        projectPath: '/tmp/alpha',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
      {
        id: 'window-2',
        name: 'beta',
        tmuxWindow: 'agentboard:2',
        projectPath: '/tmp/beta',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
    ]

    setTmuxOutput('agentboard:1', tokens)
    setTmuxOutput('agentboard:2', 'completely different text')

    const result = findMatchingWindow(logPath, windows, {
      matchScope: 'full',
      minScore: 0.5,
      minGap: 0.1,
      minTokens: 5,
    })

    expect(result.match?.tmuxWindow).toBe('agentboard:1')
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('findMatchingWindow returns null when gap is too small', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    const tokens = Array.from({ length: 60 }, (_, i) => `token${i}`).join(' ')
    const logLines = [JSON.stringify({ type: 'user', content: tokens })]
    await fs.writeFile(logPath, logLines.join('\n'))

    const windows: Session[] = [
      {
        id: 'window-1',
        name: 'alpha',
        tmuxWindow: 'agentboard:1',
        projectPath: '/tmp/alpha',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
      {
        id: 'window-2',
        name: 'beta',
        tmuxWindow: 'agentboard:2',
        projectPath: '/tmp/beta',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
    ]

    setTmuxOutput('agentboard:1', tokens)
    setTmuxOutput('agentboard:2', tokens)

    const result = findMatchingWindow(logPath, windows, {
      matchScope: 'full',
      minScore: 0.5,
      minGap: 0.2,
      minTokens: 5,
    })

    expect(result.match).toBeNull()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('findMatchingWindow matches on last exchange by default', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    const tokens = Array.from({ length: 40 }, (_, i) => `token${i}`).join(' ')
    const logLines = [
      JSON.stringify({ type: 'user', content: tokens }),
      JSON.stringify({ type: 'assistant', content: tokens }),
    ]
    await fs.writeFile(logPath, logLines.join('\n'))

    const windows: Session[] = [
      {
        id: 'window-1',
        name: 'alpha',
        tmuxWindow: 'agentboard:1',
        projectPath: '/tmp/alpha',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
      {
        id: 'window-2',
        name: 'beta',
        tmuxWindow: 'agentboard:2',
        projectPath: '/tmp/beta',
        status: 'waiting',
        lastActivity: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'managed',
      },
    ]

    const tmuxContent = `❯ previous\n⏺ ${tokens}\n❯ ${tokens}\n`
    setTmuxOutput('agentboard:1', tmuxContent)
    setTmuxOutput('agentboard:2', `❯ previous\n⏺ other text\n❯ different\n`)

    const result = findMatchingWindow(logPath, windows, {
      minScore: 0.5,
      minGap: 0.1,
      minTokens: 5,
    })

    expect(result.match?.tmuxWindow).toBe('agentboard:1')
    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
