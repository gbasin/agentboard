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
  extractPiUserMessagesFromAnsi,
  extractActionFromUserAction,
  hasMessageInValidUserContext,
  isToolNotificationText,
  extractLastEntryTimestamp,
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

/**
 * Build a log entry in proper Claude/Codex format with "text" field.
 * This format is required for the JSON field pattern matching.
 */
function buildUserLogEntry(message: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: message }] }
  })
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
    const logALines = messages.map((message) => buildUserLogEntry(message))
    const logBLines = [
      buildUserLogEntry(messages[0]),
      buildUserLogEntry(messages[2]),
      buildUserLogEntry(messages[1]),
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

    await fs.writeFile(logPath, buildUserLogEntry(message))
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

    await fs.writeFile(logPath, buildUserLogEntry(message))
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
      messagesA.map((message) => buildUserLogEntry(message)).join('\n')
    )
    await fs.writeFile(
      logPathB,
      messagesB.map((message) => buildUserLogEntry(message)).join('\n')
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
      messages.map((m) => buildUserLogEntry(m)).join('\n')
    )
    setTmuxOutput('agentboard:1', buildPromptScrollback(messages))

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir], {})
    expect(result).toBe(true)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('verifyWindowLogAssociation returns false when content does not match', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-verify-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    // Log has different content than the tmux window
    await fs.writeFile(
      logPath,
      buildUserLogEntry('log content here')
    )
    setTmuxOutput('agentboard:1', buildPromptScrollback(['different window content']))

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir], {})
    expect(result).toBe(false)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('verifyWindowLogAssociation returns false for empty terminal', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-verify-'))
    const logPath = path.join(tempDir, 'session.jsonl')

    await fs.writeFile(
      logPath,
      buildUserLogEntry('some content')
    )
    setTmuxOutput('agentboard:1', '') // Empty terminal

    const result = verifyWindowLogAssociation('agentboard:1', logPath, [tempDir], {})
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
      buildUserLogEntry(messageWithQuotes)
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

  test('Pi TUI: extracts user messages from background color', () => {
    // Pi uses RGB(52,53,65) background for user messages
    // Using \x1b for ESC character
    const ESC = '\x1b'
    const piScrollback = `
${ESC}[38;2;129;162;190m─────────────────────────────────────────────────────────────────────────────────
${ESC}[48;2;52;53;65m
 hello world


${ESC}[49m Hello! How can I help?
${ESC}[38;2;129;162;190m─────────────────────────────────────────────────────────────────────────────────
`
    const messages = extractPiUserMessagesFromAnsi(piScrollback)
    expect(messages).toContain('hello world')
  })

  test('Pi TUI: extracts multiple user messages', () => {
    const ESC = '\x1b'
    const piScrollback = `
${ESC}[48;2;52;53;65m first message ${ESC}[49m Response 1
${ESC}[48;2;52;53;65m second message ${ESC}[49m Response 2
`
    const messages = extractPiUserMessagesFromAnsi(piScrollback)
    expect(messages).toHaveLength(2)
    // Most recent first
    expect(messages[0]).toBe('second message')
    expect(messages[1]).toBe('first message')
  })

  test('Pi TUI: returns empty array for non-pi content', () => {
    const claudeScrollback = '❯ hello world'
    const messages = extractPiUserMessagesFromAnsi(claudeScrollback)
    expect(messages).toEqual([])
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

describe('hasMessageInValidUserContext', () => {
  describe('positive cases - should match', () => {
    test('matches Claude format with "text" field', () => {
      const claudeLog = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"scaffold the xcode project"}]}}'
      expect(hasMessageInValidUserContext(claudeLog, 'scaffold the xcode project')).toBe(true)
    })

    test('matches Claude format with direct "content" string (no tool_result)', () => {
      const claudeLog = '{"type":"user","message":{"role":"user","content":"scaffold the xcode project"}}'
      expect(hasMessageInValidUserContext(claudeLog, 'scaffold the xcode project')).toBe(true)
    })

    test('matches user message containing tool_result substring', () => {
      const claudeLog =
        '{"type":"user","message":{"role":"user","content":"please explain tool_result semantics"}}'
      expect(hasMessageInValidUserContext(claudeLog, 'explain tool_result')).toBe(true)
    })

    test('matches Codex response_item format with "text" field', () => {
      const codexLog = '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"help me debug this"}]}}'
      expect(hasMessageInValidUserContext(codexLog, 'help me debug this')).toBe(true)
    })

    test('matches Codex event_msg format with "message" field', () => {
      const codexLog = '{"type":"event_msg","payload":{"type":"user_message","message":"can you fix the bug"}}'
      expect(hasMessageInValidUserContext(codexLog, 'can you fix the bug')).toBe(true)
    })

    test('matches message with flexible whitespace', () => {
      // Log has multiple spaces, pattern should still match
      const logLine = '{"text":"hello    world"}'
      expect(hasMessageInValidUserContext(logLine, 'hello world')).toBe(true)
    })

    test('matches message with escaped quotes in JSON', () => {
      // JSON escapes quotes as \"
      const logLine = '{"text":"why is it \\"working\\""}'
      expect(hasMessageInValidUserContext(logLine, 'why is it "working"')).toBe(true)
    })

    test('matches message preceded by other content in same JSON string', () => {
      const logLine = '{"text":"prefix content and the actual message here"}'
      expect(hasMessageInValidUserContext(logLine, 'the actual message')).toBe(true)
    })

    test('matches when message contains special regex characters', () => {
      const logLine = '{"text":"what does (foo|bar) mean?"}'
      expect(hasMessageInValidUserContext(logLine, 'what does (foo|bar) mean?')).toBe(true)
    })
  })

  describe('negative cases - should NOT match', () => {
    test('does not match tool_result content field (terminal capture)', () => {
      // This is a tool_result that captured terminal output
      const toolResult = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"123","type":"tool_result","content":"=== TERMINAL ===\\n❯ scaffold the xcode project"}]}}'
      expect(hasMessageInValidUserContext(toolResult, 'scaffold the xcode project')).toBe(false)
    })

    test('does not match top-level toolUseResult content', () => {
      const toolUseResult = JSON.stringify({
        type: 'user',
        toolUseResult: {
          type: 'text',
          file: {
            content: '=== TERMINAL ===\n❯ scaffold the xcode project',
            filePath: '/tmp/output.txt',
            startLine: 1,
            numLines: 2,
            totalLines: 2,
          },
        },
      })
      expect(hasMessageInValidUserContext(toolUseResult, 'scaffold the xcode project')).toBe(false)
    })

    test('does not match Codex custom_tool_call_output content', () => {
      const toolOutput = JSON.stringify({
        type: 'event',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_123',
          output: '❯ implement the feature',
        },
      })
      expect(hasMessageInValidUserContext(toolOutput, 'implement the feature')).toBe(false)
    })

    test('does not match message appearing outside JSON structure', () => {
      const plainText = 'just some random text in a file'
      expect(hasMessageInValidUserContext(plainText, 'random text')).toBe(false)
    })

    test('does not match message in wrong field name', () => {
      const logLine = '{"data":"important data"}'
      expect(hasMessageInValidUserContext(logLine, 'important data')).toBe(false)
    })

    test('does not match message in "description" field', () => {
      const logLine = '{"description":"fix the bug please"}'
      expect(hasMessageInValidUserContext(logLine, 'fix the bug')).toBe(false)
    })
  })

  describe('edge cases', () => {
    test('handles empty message', () => {
      const logLine = '{"text":""}'
      // Should not throw
      expect(() => hasMessageInValidUserContext(logLine, '')).not.toThrow()
    })

    test('handles message with newlines (JSON-escaped)', () => {
      // JSON newlines are \n in the string
      const logLine = '{"text":"line one\\nline two"}'
      expect(hasMessageInValidUserContext(logLine, 'line one')).toBe(true)
    })

    test('handles message that looks like JSON', () => {
      // User actually typed something that looks like JSON
      const logLine = '{"text":"set \\"text\\": \\"value\\""}'
      expect(hasMessageInValidUserContext(logLine, 'set "text": "value"')).toBe(true)
    })

    test('handles unicode in message', () => {
      const logLine = '{"text":"hello 世界 🌍"}'
      expect(hasMessageInValidUserContext(logLine, 'hello 世界 🌍')).toBe(true)
    })

    test('works with multiline log content', () => {
      const multilineLog = `{"type":"assistant","text":"some response"}
{"type":"user","text":"user request"}
{"type":"assistant","text":"another response"}`
      expect(hasMessageInValidUserContext(multilineLog, 'user request')).toBe(true)
    })
  })
})

describe('integration: JSON field pattern filters terminal captures', () => {
  test('tryExactMatchWindowToLog excludes logs with message only in tool_result', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-toolresult-'))

    // Log A: has message as actual user message
    const logPathA = path.join(tempDir, 'session-a.jsonl')
    // Log B: has same message but only inside a tool_result (terminal capture)
    const logPathB = path.join(tempDir, 'session-b.jsonl')

    const userMessage = 'implement the feature'

    // Log A: proper user message
    await fs.writeFile(
      logPathA,
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: userMessage }] }
      })
    )

    // Log B: message appears only in tool_result (terminal capture from another window)
    await fs.writeFile(
      logPathB,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{
            tool_use_id: 'tool_123',
            type: 'tool_result',
            content: `=== TERMINAL CAPTURE ===\n❯ ${userMessage}\n⏺ Working on it...`
          }]
        }
      })
    )

    setTmuxOutput('agentboard:1', buildPromptScrollback([userMessage]))

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    // Should match Log A (actual user message), not Log B (terminal capture)
    expect(result?.logPath).toBe(logPathA)

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  test('tryExactMatchWindowToLog matches correct log when both have message in different contexts', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-context-'))

    const logPathCorrect = path.join(tempDir, 'correct.jsonl')
    const logPathWrong = path.join(tempDir, 'wrong.jsonl')

    const messages = ['first message', 'second message', 'third message']

    // Correct log: has all messages as actual user messages
    const correctLines = messages.map(msg =>
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: msg }] } })
    )
    await fs.writeFile(logPathCorrect, correctLines.join('\n'))

    // Wrong log: has messages inside tool_result (captured terminal)
    const wrongLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: messages.map(m => `❯ ${m}`).join('\n')
        }]
      }
    })
    await fs.writeFile(logPathWrong, wrongLine)

    setTmuxOutput('agentboard:1', buildPromptScrollback(messages))

    const result = tryExactMatchWindowToLog('agentboard:1', tempDir)
    expect(result?.logPath).toBe(logPathCorrect)

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})

describe('isToolNotificationText', () => {
  describe('should filter (return true)', () => {
    test('filters Codex CLI apply_patch warning', () => {
      const warning = 'Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead of exec_command.'
      expect(isToolNotificationText(warning)).toBe(true)
    })

    test('filters other tool warnings via exec_command', () => {
      expect(isToolNotificationText('Warning: some_tool was requested via exec_command. Use the proper tool.')).toBe(true)
    })

    test('filters task notifications', () => {
      expect(isToolNotificationText('<task-notification>Task completed</task-notification>')).toBe(true)
    })

    test('filters messages with task-id', () => {
      expect(isToolNotificationText('Task <task-id>abc123</task-id> is running')).toBe(true)
    })

    test('filters messages with instructions tag', () => {
      expect(isToolNotificationText('<instructions>Follow these steps</instructions>')).toBe(true)
    })
  })

  describe('should NOT filter (return false)', () => {
    test('allows normal user messages', () => {
      expect(isToolNotificationText('Please fix the bug in the login form')).toBe(false)
    })

    test('allows messages mentioning warnings in conversation', () => {
      expect(isToolNotificationText('I saw a warning in the console, can you help?')).toBe(false)
    })

    test('allows messages discussing exec_command', () => {
      expect(isToolNotificationText('How do I use exec_command properly?')).toBe(false)
    })

    test('allows messages with Warning not at start', () => {
      expect(isToolNotificationText('The compiler showed: Warning: unused variable')).toBe(false)
    })

    test('allows messages that mention apply_patch normally', () => {
      expect(isToolNotificationText('Can you apply_patch to fix the issue?')).toBe(false)
    })

    test('allows empty string', () => {
      expect(isToolNotificationText('')).toBe(false)
    })

    test('allows whitespace only', () => {
      expect(isToolNotificationText('   ')).toBe(false)
    })
  })
})

describe('extractLastEntryTimestamp', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-timestamp-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test('extracts timestamp from last entry', async () => {
    const logPath = path.join(tmpDir, 'test.jsonl')
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'message' }),
        JSON.stringify({ timestamp: '2025-01-02T00:00:00Z', type: 'message' }),
        JSON.stringify({ timestamp: '2025-01-03T00:00:00Z', type: 'message' }),
      ].join('\n')
    )
    expect(extractLastEntryTimestamp(logPath)).toBe('2025-01-03T00:00:00Z')
  })

  test('returns null for empty file', async () => {
    const logPath = path.join(tmpDir, 'empty.jsonl')
    await fs.writeFile(logPath, '')
    expect(extractLastEntryTimestamp(logPath)).toBe(null)
  })

  test('returns null for non-existent file', () => {
    const logPath = path.join(tmpDir, 'nonexistent.jsonl')
    expect(extractLastEntryTimestamp(logPath)).toBe(null)
  })

  test('skips malformed JSON lines', async () => {
    const logPath = path.join(tmpDir, 'malformed.jsonl')
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'message' }),
        'this is not valid json',
        '{ broken json',
      ].join('\n')
    )
    // Should find the first (only valid) entry
    expect(extractLastEntryTimestamp(logPath)).toBe('2025-01-01T00:00:00Z')
  })

  test('returns null when no entries have timestamp field', async () => {
    const logPath = path.join(tmpDir, 'no-timestamp.jsonl')
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ type: 'message', content: 'hello' }),
        JSON.stringify({ type: 'message', content: 'world' }),
      ].join('\n')
    )
    expect(extractLastEntryTimestamp(logPath)).toBe(null)
  })

  test('finds timestamp even if last line has none', async () => {
    const logPath = path.join(tmpDir, 'mixed.jsonl')
    await fs.writeFile(
      logPath,
      [
        JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'message' }),
        JSON.stringify({ timestamp: '2025-01-02T00:00:00Z', type: 'message' }),
        JSON.stringify({ type: 'status', content: 'no timestamp here' }),
      ].join('\n')
    )
    // Should iterate backwards and find the second entry's timestamp
    expect(extractLastEntryTimestamp(logPath)).toBe('2025-01-02T00:00:00Z')
  })

  test('handles trailing newline', async () => {
    const logPath = path.join(tmpDir, 'trailing.jsonl')
    await fs.writeFile(
      logPath,
      JSON.stringify({ timestamp: '2025-01-01T00:00:00Z', type: 'message' }) + '\n'
    )
    expect(extractLastEntryTimestamp(logPath)).toBe('2025-01-01T00:00:00Z')
  })
})
