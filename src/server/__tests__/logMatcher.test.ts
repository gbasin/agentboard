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
  verifyWindowLogAssociation,
  extractRecentTraceLinesFromTmux,
  extractRecentUserMessagesFromTmux,
  extractActionFromUserAction,
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

  test('tryExactMatchWindowToLog falls back to trace lines and skips subagents', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-logmatch-'))
    const logPathMain = path.join(tempDir, 'session-main.jsonl')
    const logPathSub = path.join(tempDir, 'session-sub.jsonl')
    const traceLine =
      'The new last-user-message feature can get stuck showing stale values because log updates are ignored once a message is set.'

    await fs.writeFile(
      logPathMain,
      [
        JSON.stringify({ type: 'session_meta', payload: { source: 'cli' } }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_reasoning', text: traceLine },
        }),
      ].join('\n')
    )
    await fs.writeFile(
      logPathSub,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { source: { subagent: 'review' } },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_reasoning', text: traceLine },
        }),
      ].join('\n')
    )

    setTmuxOutput('agentboard:1', CODEX_REVIEW_SCROLLBACK)

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPathMain)

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

  test('verifyWindowLogAssociation returns true when content matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-verify-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const messages = ['verify test one', 'verify test two']

    await fs.writeFile(
      logPath,
      messages.map((m) => JSON.stringify({ type: 'user', content: m })).join('\n')
    )
    setTmuxOutput('agentboard:1', buildPromptScrollback(messages))

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir])
    expect(result).toBe(true)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('verifyWindowLogAssociation returns false when content does not match', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-verify-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    // Log has different content than the tmux window
    await fs.writeFile(
      logPath,
      JSON.stringify({ type: 'user', content: 'log content here' })
    )
    setTmuxOutput('agentboard:1', buildPromptScrollback(['different window content']))

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir])
    expect(result).toBe(false)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('verifyWindowLogAssociation returns false for empty terminal', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-verify-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    await fs.writeFile(
      logPath,
      JSON.stringify({ type: 'user', content: 'some content' })
    )
    setTmuxOutput('agentboard:1', '') // Empty terminal

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir])
    expect(result).toBe(false)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('tryExactMatchWindowToLog matches messages with JSON-escaped quotes', async () => {
    // Regression test: terminal shows "working" but log has \"working\" (JSON-escaped)
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-quotes-'))
    const logPath = path.join(tempDir, 'session.jsonl')
    const messageWithQuotes = 'why is it appearing as "working" in the UI?'

    // JSON.stringify escapes quotes as \" in the log file
    await fs.writeFile(
      logPath,
      JSON.stringify({ type: 'user', content: messageWithQuotes })
    )
    // Terminal shows unescaped quotes
    setTmuxOutput('agentboard:1', buildPromptScrollback([messageWithQuotes]))

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPath)

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})

// Regression test fixtures from real tmux sessions
// Codex session after running /review command - no visible user prompt (swallowed by slash command)
const CODEX_REVIEW_SCROLLBACK = `• Explored
  └ Read logPoller.ts

• The update code sets lastUserMessage only if missing or a tool notification.

• Explored
  └ Read SessionList.tsx

• I'm verifying that lastUserMessage updates correctly.

  Identifying stale lastUserMessage update bug

  I found that logPoller only updates lastUserMessage when the existing message is missing.

<< Code review finished >>

─ Worked for 12m 25s ─────────────────────────────────────────────────────────

• The new last-user-message feature can get stuck showing stale values because log updates are ignored once a message is set.

  Review comment:

  - [P2] Update lastUserMessage when newer log input arrives
    The log poller only writes lastUserMessage when the stored value is empty.


› Find and fix a bug in @filename

  100% context left · ? for shortcuts
`

// Claude session with submitted prompt and assistant response, plus pending input
const CLAUDE_PROMPT_SCROLLBACK = `  Right now it's reading every file every poll cycle just to throw away the data.

✻ Brewed for 33s

❯ yes create a test and then fix it

⏺ I'll create a test first to verify the optimization, then fix the code. Let me start by understanding the test structure.

⏺ Read(src/server/__tests__/logPollData.test.ts)
  ⎿  Read 139 lines

⏺ Read(src/server/__tests__/logPoller.test.ts)
  ⎿  Read 345 lines

⏺ Now I understand the full flow. Let me write a test and then fix the code.

⏺ Update(src/server/__tests__/logPoller.test.ts)
  ⎿  Added 57 lines

────────────────────────────────────────────────────────────────────────────────
❯ commit these changes                                                   ↵ send
────────────────────────────────────────────────────────────────────────────────
  Opus 4.5 in agentboard on master [20%]
  ⏵⏵ accept edits on (shift+tab to cycle)
`

describe('message extraction regression tests', () => {
  test('Codex /review: returns empty userMessages when prompt is swallowed', () => {
    const userMessages = extractRecentUserMessagesFromTmux(CODEX_REVIEW_SCROLLBACK)
    // The only › line is a UI tip in the input field, not a real user message
    expect(userMessages).toEqual([])
  })

  test('Codex /review: extracts trace lines for fallback', () => {
    const traces = extractRecentTraceLinesFromTmux(CODEX_REVIEW_SCROLLBACK)
    expect(traces).toContain(
      'The new last-user-message feature can get stuck showing stale values because log updates are ignored once a message is set.'
    )
  })

  test('Claude: returns submitted userMessages, not pending', () => {
    const userMessages = extractRecentUserMessagesFromTmux(CLAUDE_PROMPT_SCROLLBACK)
    // Should find the submitted message
    expect(userMessages).toContain('yes create a test and then fix it')
    // Should NOT include the pending message (has ↵ send indicator)
    expect(userMessages).not.toContain('commit these changes')
  })
})

describe('extractActionFromUserAction', () => {
  test('extracts action from valid user_action XML', () => {
    const xml = `<user_action>
  <context>User initiated a review task.</context>
  <action>review</action>
  <results>Some review results here</results>
</user_action>`
    expect(extractActionFromUserAction(xml)).toBe('review')
  })

  test('extracts action with whitespace', () => {
    const xml = '<user_action><action>  commit  </action></user_action>'
    expect(extractActionFromUserAction(xml)).toBe('commit')
  })

  test('returns null for non-user_action text', () => {
    expect(extractActionFromUserAction('hello world')).toBeNull()
    expect(extractActionFromUserAction('<other_tag>content</other_tag>')).toBeNull()
    expect(extractActionFromUserAction('')).toBeNull()
  })

  test('returns null when no action tag present', () => {
    const xml = '<user_action><context>No action here</context></user_action>'
    expect(extractActionFromUserAction(xml)).toBeNull()
  })

  test('handles case-insensitive matching', () => {
    const xml = '<USER_ACTION><action>test</action></USER_ACTION>'
    expect(extractActionFromUserAction(xml)).toBe('test')
  })
})
