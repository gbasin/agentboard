import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Session } from '../../shared/types'
import {
  normalizeText,
  matchWindowsToLogsByExactRg,
  tryExactMatchWindowToLog,
} from '../logMatcher'

const bunAny = Bun as typeof Bun & { spawnSync: typeof Bun.spawnSync }
const originalSpawnSync = bunAny.spawnSync

const tmuxOutputs = new Map<string, string>()

function setTmuxOutput(target: string, content: string) {
  tmuxOutputs.set(target, content)
}

function findJsonlFiles(dir: string): string[] {
  const results: string[] = []
  if (!fsSync.existsSync(dir)) return results
  const entries = fsSync.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath)
    }
  }
  return results
}

function runRg(args: string[]) {
  const patternIndex = args.indexOf('-e')
  const pattern = patternIndex >= 0 ? args[patternIndex + 1] ?? '' : ''
  const regex = pattern ? new RegExp(pattern, 'm') : null

  if (args.includes('--json')) {
    const filePath = args[args.length - 1] ?? ''
    if (!filePath || !regex || !fsSync.existsSync(filePath)) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const lines = fsSync.readFileSync(filePath, 'utf8').split('\n')
    const output: string[] = []
    lines.forEach((line, index) => {
      if (regex.test(line)) {
        output.push(
          JSON.stringify({ type: 'match', data: { line_number: index + 1 } })
        )
      }
    })
    const exitCode = output.length > 0 ? 0 : 1
    return {
      exitCode,
      stdout: Buffer.from(output.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  if (args.includes('-l')) {
    if (!regex) {
      return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
    }
    const targets: string[] = []
    let skipNext = false
    for (let i = patternIndex + 2; i < args.length; i += 1) {
      const arg = args[i] ?? ''
      if (skipNext) {
        skipNext = false
        continue
      }
      if (!arg) continue
      if (arg === '--glob') {
        skipNext = true
        continue
      }
      if (arg === '--threads') {
        skipNext = true
        continue
      }
      if (arg.startsWith('-')) {
        continue
      }
      targets.push(arg)
    }
    const files: string[] = []
    for (const target of targets) {
      if (!fsSync.existsSync(target)) continue
      const stat = fsSync.statSync(target)
      if (stat.isDirectory()) {
        files.push(...findJsonlFiles(target))
      } else if (stat.isFile()) {
        files.push(target)
      }
    }
    const matches = files.filter((file) => {
      const content = fsSync.readFileSync(file, 'utf8')
      return regex.test(content)
    })
    return {
      exitCode: matches.length > 0 ? 0 : 1,
      stdout: Buffer.from(matches.join('\n')),
      stderr: Buffer.from(''),
    }
  }

  return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
}

function buildPromptScrollback(
  messages: string[],
  options: { prefix?: string; glyph?: string } = {}
): string {
  const prefix = options.prefix ?? ''
  const glyph = options.glyph ?? '❯'
  return messages
    .map((message) => `${prefix}${glyph} ${message}\n⏺ ok`)
    .join('\n')
    .concat('\n')
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
    if (args[0] === 'rg') {
      return runRg(args) as ReturnType<typeof Bun.spawnSync>
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

  test('tryExactMatchWindowToLog uses ordered prompts to disambiguate', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPathA = path.join(tempDir, 'session-a.jsonl')
    const logPathB = path.join(tempDir, 'session-b.jsonl')
    const messages = ['alpha one', 'alpha two', 'alpha three']
    const logALines = messages.map((message) =>
      JSON.stringify({ type: 'user', content: message })
    )
    const logBLines = [
      JSON.stringify({ type: 'user', content: messages[0] }),
      JSON.stringify({ type: 'user', content: messages[2] }),
      JSON.stringify({ type: 'user', content: messages[1] }),
    ]

    await fs.writeFile(logPathA, logALines.join('\n'))
    await fs.writeFile(logPathB, logBLines.join('\n'))

    setTmuxOutput('agentboard:1', buildPromptScrollback(messages))

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPathA)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('tryExactMatchWindowToLog detects decorated Claude prompts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const message = 'decorated claude prompt'

    await fs.writeFile(logPath, JSON.stringify({ type: 'user', content: message }))
    setTmuxOutput(
      'agentboard:1',
      buildPromptScrollback([message], { prefix: '> ' })
    )

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPath)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('tryExactMatchWindowToLog detects decorated Codex prompts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const message = 'decorated codex prompt'

    await fs.writeFile(logPath, JSON.stringify({ type: 'user', content: message }))
    setTmuxOutput(
      'agentboard:1',
      buildPromptScrollback([message], { prefix: '* ', glyph: '›' })
    )

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPath)
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('matchWindowsToLogsByExactRg returns unique matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPathA = path.join(tempDir, 'session-a.jsonl')
    const logPathB = path.join(tempDir, 'session-b.jsonl')
    const messagesA = ['alpha one', 'alpha two']
    const messagesB = ['beta one', 'beta two']

    await fs.writeFile(
      logPathA,
      messagesA.map((message) => JSON.stringify({ type: 'user', content: message })).join('\n')
    )
    await fs.writeFile(
      logPathB,
      messagesB.map((message) => JSON.stringify({ type: 'user', content: message })).join('\n')
    )

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

    setTmuxOutput('agentboard:1', buildPromptScrollback(messagesA))
    setTmuxOutput('agentboard:2', buildPromptScrollback(messagesB))

    const results = matchWindowsToLogsByExactRg(windows, tempDir)
    expect(results.get(logPathA)?.tmuxWindow).toBe('agentboard:1')
    expect(results.get(logPathB)?.tmuxWindow).toBe('agentboard:2')

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})
