import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  clearPrScanCache,
  extractPullRequests,
  getSessionPullRequests,
} from '../prExtractor'

let tempRoot: string

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-pr-'))
  clearPrScanCache()
})

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

function claudeBashToolUse(command: string, id = 'toolu_1'): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 's1',
    message: {
      content: [
        { type: 'tool_use', id, name: 'Bash', input: { command } },
      ],
    },
  })
}

function claudeToolResult(text: string, toolUseId = 'toolu_1'): string {
  return JSON.stringify({
    type: 'user',
    sessionId: 's1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  })
}

describe('extractPullRequests', () => {
  test('captures PR URL from tool result after gh pr create', () => {
    const content = [
      claudeBashToolUse('gh pr create --fill'),
      claudeToolResult('https://github.com/acme/widgets/pull/42\n'),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([
      {
        url: 'https://github.com/acme/widgets/pull/42',
        repo: 'acme/widgets',
        number: 42,
      },
    ])
  })

  test('attributes the URL via the tool_use id even after many intervening lines', () => {
    const lines = [claudeBashToolUse('gh pr create', 'toolu_abc')]
    for (let i = 0; i < 50; i++) lines.push('{"type":"progress"}')
    lines.push(claudeToolResult('https://github.com/a/b/pull/9', 'toolu_abc'))

    expect(extractPullRequests(lines.join('\n'))).toEqual([
      { url: 'https://github.com/a/b/pull/9', repo: 'a/b', number: 9 },
    ])
  })

  test('does not attribute URLs from a different tool call', () => {
    const content = [
      claudeBashToolUse('gh pr create', 'toolu_create'),
      claudeToolResult('https://github.com/a/b/pull/9', 'toolu_other'),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores gh pr create mentioned in user prose near a PR link', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: {
          content: 'Do not run gh pr create. Review https://github.com/a/b/pull/12',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores gh pr create in assistant text that accompanies another tool call', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'I will not run gh pr create' },
            {
              type: 'tool_use',
              id: 'toolu_x',
              name: 'Bash',
              input: { command: 'gh pr list' },
            },
          ],
        },
      }),
      claudeToolResult('https://github.com/a/b/pull/5', 'toolu_x'),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('handles extra whitespace and -R flag in the command', () => {
    const content = [
      claudeBashToolUse('gh  -R a/b  pr   create --title "x"'),
      claudeToolResult('https://github.com/a/b/pull/7'),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([7])
  })

  test('collects multiple PRs and dedupes repeated URLs', () => {
    const content = [
      claudeBashToolUse('gh pr create', 'toolu_1'),
      claudeToolResult('https://github.com/a/b/pull/1', 'toolu_1'),
      claudeToolResult('again https://github.com/a/b/pull/1', 'toolu_1'),
      claudeBashToolUse('cd other && gh pr create', 'toolu_2'),
      claudeToolResult('https://github.com/c/d/pull/2', 'toolu_2'),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([
      { url: 'https://github.com/a/b/pull/1', repo: 'a/b', number: 1 },
      { url: 'https://github.com/c/d/pull/2', repo: 'c/d', number: 2 },
    ])
  })

  test('works on codex-style function_call output', () => {
    const content = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"command":["gh","pr","create","--fill"]}',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'https://github.com/o/r/pull/77',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([77])
  })

  test('falls back to lookahead window for unparseable create lines', () => {
    const content = [
      'NOTJSON "tool_use" gh pr create',
      claudeToolResult('https://github.com/a/b/pull/3'),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([3])
  })
})

describe('getSessionPullRequests', () => {
  test('returns empty for missing file', () => {
    expect(getSessionPullRequests(path.join(tempRoot, 'nope.jsonl'))).toEqual(
      []
    )
  })

  test('reads file and caches results by offset', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    await fs.writeFile(
      logPath,
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/3')].join('\n') + '\n'
    )

    const first = getSessionPullRequests(logPath)
    expect(first.map((p) => p.number)).toEqual([3])
    // Subsequent calls return an equal snapshot, not the same live array
    const second = getSessionPullRequests(logPath)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  test('skips rescanning when knownSize matches the consumed offset', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    const content =
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/3')].join('\n') + '\n'
    await fs.writeFile(logPath, content)

    const first = getSessionPullRequests(logPath)
    expect(first).toHaveLength(1)
    // knownSize equal to the file size should return cached results
    // (even if the file were replaced between calls, the size check wins)
    const cached = getSessionPullRequests(logPath, content.length)
    expect(cached.map((p) => p.number)).toEqual([3])
  })

  test('incrementally picks up PRs appended later', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    await fs.writeFile(logPath, claudeBashToolUse('echo hi') + '\n')
    expect(getSessionPullRequests(logPath)).toEqual([])

    await fs.appendFile(
      logPath,
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/4')].join('\n') + '\n'
    )
    expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([4])
  })

  test('rescans when the file is truncated', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    await fs.writeFile(
      logPath,
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/1')].join('\n') + '\n'
    )
    expect(getSessionPullRequests(logPath)).toHaveLength(1)

    await fs.writeFile(logPath, '{}\n')
    expect(getSessionPullRequests(logPath)).toEqual([])
  })

  test('rescans a same-size rewrite detected via mtime', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    const v1 =
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/41')].join('\n') + '\n'
    const v2 =
      [claudeBashToolUse('gh pr create'), claudeToolResult('https://github.com/a/b/pull/43')].join('\n') + '\n'
    expect(v2.length).toBe(v1.length)

    await fs.writeFile(logPath, v1)
    expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([41])

    await fs.writeFile(logPath, v2)
    // Bump mtime so the rewrite is detectable even at coarse timestamp granularity
    const future = new Date(Date.now() + 10_000)
    await fs.utimes(logPath, future, future)
    expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([43])
  })

  test('handles a command line split across incremental reads', async () => {
    const logPath = path.join(tempRoot, 's.jsonl')
    const createLine = claudeBashToolUse('gh pr create')
    // Split mid-line so the first read ends with a partial line
    const cut = Math.floor(createLine.length / 2)
    await fs.writeFile(logPath, createLine.slice(0, cut))
    expect(getSessionPullRequests(logPath)).toEqual([])

    await fs.appendFile(
      logPath,
      createLine.slice(cut) + '\n' + claudeToolResult('https://github.com/a/b/pull/8') + '\n'
    )
    expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([8])
  })
})
