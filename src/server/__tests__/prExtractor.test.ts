import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { heapStats } from 'bun:jsc'
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

  test('finds gh pr create after an escaped newline inside a command', () => {
    // In raw JSONL, embedded newlines in input.command are literal \n, so the
    // raw text reads "...EOF\ngh pr create" — the `n` before `g` kills \b.
    const command = 'cat > /tmp/pr-body <<\'EOF\'\nbody\nEOF\ngh pr create -R a/b --fill'
    const content = [
      claudeBashToolUse(command, 'toolu_heredoc'),
      claudeToolResult('https://github.com/a/b/pull/55', 'toolu_heredoc'),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([55])
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

  test('works on codex unified-exec CommandExecution entries', () => {
    // cli ~0.150+: the create call is an `exec` custom_tool_call wrapping a
    // JS snippet, and the URL lands in a later custom_tool_call_output for a
    // *different* call_id (a write_stdin poll). The item_completed
    // CommandExecution entry carries argv + stdout on the same line.
    const content = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc_1',
          status: 'completed',
          call_id: 'call_create',
          name: 'exec',
          input:
            'text(await tools.exec_command({cmd:"gh pr create --fill",yield_time_ms:1000}));',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          id: 'ctco_1',
          call_id: 'call_create',
          output: [
            { type: 'input_text', text: '{"session_id":94558,"output":""}' },
          ],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc_2',
          call_id: 'call_poll',
          name: 'exec',
          input:
            'text(await tools.write_stdin({session_id:94558,chars:""}));',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          id: 'ctco_2',
          call_id: 'call_poll',
          output: [
            {
              type: 'input_text',
              text: '{"output":"https://github.com/o/r/pull/88\\n"}',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'exec-1',
            command: ['/bin/zsh', '-lc', 'gh pr create --fill'],
            status: 'completed',
            stdout: 'https://github.com/o/r/pull/88\n',
            exit_code: 0,
          },
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([88])
  })

  test('works on codex custom_tool_call_output sharing the create call_id', () => {
    // When the exec finishes inside the first yield window, the URL arrives
    // in a custom_tool_call_output for the create's own call_id — no
    // CommandExecution entry is needed for attribution.
    const content = [
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          id: 'ctc_9',
          status: 'completed',
          call_id: 'call_fast',
          name: 'exec',
          input:
            'text(await tools.exec_command({cmd:"gh pr create --fill"}));',
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          id: 'ctco_9',
          call_id: 'call_fast',
          output: [
            {
              type: 'input_text',
              text: '{"output":"https://github.com/o/r/pull/91\\n"}',
            },
          ],
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([91])
  })

  test('ignores CommandExecution entries that did not run gh pr create', () => {
    const content = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'exec-2',
            command: ['/bin/zsh', '-lc', 'gh pr list --json url'],
            status: 'completed',
            stdout: 'https://github.com/o/r/pull/8\n',
            exit_code: 0,
          },
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores gh pr create text in CommandExecution stdout only', () => {
    const content = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution',
            id: 'exec-3',
            command: ['/bin/zsh', '-lc', 'cat notes.md'],
            status: 'completed',
            stdout:
              'run gh pr create like https://github.com/o/r/pull/12\n',
            exit_code: 0,
          },
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('works on pi-style toolCall/toolResult entries', () => {
    const content = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call_pi1',
              name: 'bash',
              arguments: { command: 'gh pr create --fill' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call_pi1',
          toolName: 'bash',
          content: [
            { type: 'text', text: 'https://github.com/o/r/pull/55' },
          ],
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([55])
  })

  test('does not attribute pi toolCall ids when a different call ran', () => {
    const content = [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'you could run gh pr create here' },
            {
              type: 'toolCall',
              id: 'call_other',
              name: 'bash',
              arguments: { command: 'gh pr list' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 'call_other',
          content: [{ type: 'text', text: 'https://github.com/o/r/pull/8' }],
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('works on devin mirrored toolCalls/tool results', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        agent: 'devin',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_dv1',
              name: 'shell',
              arguments: '{"command":"gh pr create --fill"}',
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'tool',
        agent: 'devin',
        message: {
          role: 'tool',
          toolCallId: 'call_dv1',
          content: 'https://github.com/o/r/pull/66',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([66])
  })

  test('works on grok tool_calls/tool_result entries', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        model_fingerprint: 'fp',
        tool_calls: [
          {
            id: 'call-gk1',
            name: 'shell',
            arguments: '{"command":"gh pr create --fill"}',
          },
        ],
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_call_id: 'call-gk1',
        content: 'https://github.com/o/r/pull/77',
      }),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([77])
  })

  test('does not attribute grok URLs from a different tool call', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        model_fingerprint: 'fp',
        tool_calls: [
          { id: 'call-gk2', name: 'shell', arguments: '{"command":"gh pr list"}' },
        ],
      }),
      JSON.stringify({
        type: 'tool_result',
        tool_call_id: 'call-gk2',
        content: 'https://github.com/o/r/pull/8',
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('does not attribute devin URLs from a different tool call', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        agent: 'devin',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_dv2', name: 'shell', arguments: 'gh pr list' },
          ],
        },
      }),
      JSON.stringify({
        type: 'tool',
        agent: 'devin',
        message: {
          role: 'tool',
          toolCallId: 'call_dv2',
          content: 'https://github.com/o/r/pull/7',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores devin prose that mentions gh pr create and PR URLs', () => {
    // Devin mirrors real tool calls as message.toolCalls with ids, so prose
    // announcing a create is not evidence — this used to false-positive via
    // the blanket "agent":"devin" tool-call match + lookahead window.
    const content = [
      JSON.stringify({
        type: 'assistant',
        agent: 'devin',
        message: {
          role: 'assistant',
          content: 'Running gh pr create --fill now',
        },
      }),
      JSON.stringify({
        type: 'assistant',
        agent: 'devin',
        message: {
          role: 'assistant',
          content: 'PR opened: https://github.com/gbasin/agentboard/pull/228',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores gh pr create quoted inside devin tool output', () => {
    // Regression: a session that reads source mentioning `gh pr create`
    // (e.g. this file) must not vacuum up PR URLs from nearby results.
    const content = [
      JSON.stringify({
        type: 'tool',
        agent: 'devin',
        message: {
          role: 'tool',
          toolCallId: 'call_read',
          content:
            'const RE = /"tool_use"/ // a `gh pr create` mention only counts',
        },
      }),
      JSON.stringify({
        type: 'tool',
        agent: 'devin',
        message: {
          role: 'tool',
          toolCallId: 'call_grep',
          content:
            'https://github.com/a/b/pull/78\nhttps://github.com/c/d/pull/1500',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores devin edit calls whose file content mentions gh pr create', () => {
    // A write/edit tool call is not a shell exec — text about `gh pr create`
    // in new_string must not register the call as a create.
    const content = [
      JSON.stringify({
        type: 'assistant',
        agent: 'devin',
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_edit',
              name: 'edit',
              arguments: {
                file_path: '/x.test.ts',
                new_string: "claudeBashToolUse('gh pr create')",
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'tool',
        agent: 'devin',
        message: {
          role: 'tool',
          toolCallId: 'call_edit',
          content:
            'wrote 12|  gh pr create\n13|  https://github.com/a/b/pull/78',
        },
      }),
    ].join('\n')

    expect(extractPullRequests(content)).toEqual([])
  })

  test('ignores PR URLs on non-result lines inside the fallback window', () => {
    const content = [
      'NOTJSON "tool_use" gh pr create',
      JSON.stringify({ type: 'assistant', note: 'see https://github.com/a/b/pull/4' }),
      claudeToolResult('https://github.com/a/b/pull/3'),
    ].join('\n')

    expect(extractPullRequests(content).map((p) => p.number)).toEqual([3])
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

  test('cached results do not pin the log text they were found in', async () => {
    // Each log is ~1 MB of filler around one PR URL. The cache keeps a URL
    // and a repo name per log; a substring of the decoded chunk would keep
    // the whole megabyte alive with it.
    const logCount = 24
    const filler = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < logCount; i++) {
      await fs.writeFile(
        path.join(tempRoot, `s${i}.jsonl`),
        [
          claudeBashToolUse('gh pr create'),
          claudeToolResult(`${filler} https://github.com/a/b/pull/${i} done`),
          // No trailing newline: the partial last line is carried too.
          claudeToolResult('still streaming'),
        ].join('\n')
      )
    }

    Bun.gc(true)
    const before = heapStats()
    for (let i = 0; i < logCount; i++) {
      const prs = getSessionPullRequests(path.join(tempRoot, `s${i}.jsonl`))
      expect(prs.map((p) => p.number)).toEqual([i])
    }
    Bun.gc(true)
    const after = heapStats()

    const retained =
      after.heapSize + after.extraMemorySize - (before.heapSize + before.extraMemorySize)
    expect(retained).toBeLessThan(4 * 1024 * 1024)
  })
  describe('chunk prefilter', () => {
    const CHUNK = 128 * 1024
    const createLine = claudeBashToolUse('gh pr create --fill')
    const resultLine = claudeToolResult('https://github.com/a/b/pull/42')

    // Pads with `create`-free filler lines so the create line starts `offset`
    // bytes before the chunk boundary, then reads the log the way a restart
    // would: from scratch, in fixed chunks.
    async function prsWithCreateAt(offset: number): Promise<number[]> {
      const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(997) }) + '\n'
      const before = Math.floor((CHUNK - offset) / filler.length)
      const pad = 'y'.repeat(Math.max(0, CHUNK - offset - before * filler.length - 1))
      const logPath = path.join(tempRoot, `at-${offset}.jsonl`)
      await fs.writeFile(
        logPath,
        filler.repeat(before) + pad + '\n' + createLine + '\n' + filler + resultLine + '\n'
      )
      return getSessionPullRequests(logPath).map((pr) => pr.number)
    }

    test('finds a create that straddles the chunk boundary at any offset', async () => {
      for (let offset = 0; offset <= createLine.length + 4; offset++) {
        expect(await prsWithCreateAt(offset)).toEqual([42])
      }
    })

    test('finds a create split inside the word `create`', async () => {
      const word = createLine.indexOf('create')
      for (let into = 1; into < 6; into++) {
        expect(await prsWithCreateAt(createLine.length - word - into)).toEqual([42])
      }
    })

    test('finds a JSON-array argv create in a later chunk', async () => {
      const argv = claudeBashToolUse('["gh","pr","create","--fill"]', 'toolu_9')
      const filler = ('z'.repeat(2000) + '\n').repeat(100)
      const logPath = path.join(tempRoot, 'argv.jsonl')
      await fs.writeFile(
        logPath,
        filler + argv + '\n' + filler + claudeToolResult('https://github.com/a/b/pull/9', 'toolu_9') + '\n'
      )
      expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([9])
    })

    test('does not decode chunks that cannot hold a create', async () => {
      // 8 MB of prose-like lines with no `create` anywhere. Decoding them is
      // what turned a restart scan of every session log into hundreds of MB
      // of string garbage.
      const line = JSON.stringify({ type: 'user', text: 'w'.repeat(900) }) + '\n'
      const logPath = path.join(tempRoot, 'big.jsonl')
      await fs.writeFile(logPath, line.repeat(Math.ceil((8 * 1024 * 1024) / line.length)))

      const original = Buffer.prototype.toString
      let decodedChars = 0
      Buffer.prototype.toString = function (this: Buffer, ...args: Parameters<typeof original>) {
        const out = original.apply(this, args)
        decodedChars += out.length
        return out
      }
      try {
        expect(getSessionPullRequests(logPath)).toEqual([])
      } finally {
        Buffer.prototype.toString = original
      }
      expect(decodedChars).toBeLessThan(1024 * 1024)
    })

    // Counts the characters Buffer#toString produces while `run` executes.
    function countDecodedChars(run: () => void): number {
      const original = Buffer.prototype.toString
      let decodedChars = 0
      Buffer.prototype.toString = function (this: Buffer, ...args: Parameters<typeof original>) {
        const out = original.apply(this, args)
        decodedChars += out.length
        return out
      }
      try {
        run()
      } finally {
        Buffer.prototype.toString = original
      }
      return decodedChars
    }

    // One tool-result line of `size` bytes, as Claude logs an image result.
    function longResultLine(size: number, toolUseId: string, tail = ''): string {
      const shell = claudeToolResult(`IMG${tail}`, toolUseId)
      return shell.replace('IMG', 'A'.repeat(size - shell.length + 3))
    }

    test('does not decode a long line that cannot hold a create', async () => {
      // An 8 MB line spans 64 chunks with no newline in most of them. The
      // carried partial line must not be re-joined and copied per chunk.
      const size = 8 * 1024 * 1024
      const logPath = path.join(tempRoot, 'long.jsonl')
      await fs.writeFile(
        logPath,
        claudeBashToolUse('echo hi') + '\n' + longResultLine(size, 'toolu_1') + '\n' + claudeBashToolUse('ls') + '\n'
      )

      let prs: unknown[] = []
      const decoded = countDecodedChars(() => {
        prs = getSessionPullRequests(logPath)
      })
      expect(prs).toEqual([])
      expect(decoded).toBeLessThan(1024 * 1024)
    })

    test('decodes a long line that must be read only once', async () => {
      // The create is pending, so the 8 MB result line has to be parsed,
      // but decoding it whole once is enough.
      const size = 8 * 1024 * 1024
      const logPath = path.join(tempRoot, 'long-result.jsonl')
      await fs.writeFile(
        logPath,
        claudeBashToolUse('gh pr create --fill') +
          '\n' +
          longResultLine(size, 'toolu_1', ' https://github.com/a/b/pull/77') +
          '\n'
      )

      let prs: { number: number }[] = []
      const decoded = countDecodedChars(() => {
        prs = getSessionPullRequests(logPath)
      })
      expect(prs.map((p) => p.number)).toEqual([77])
      expect(decoded).toBeLessThan(2 * size)
    })

    test('finds a create whose separator is split across the chunk boundary', async () => {
      // `gh pr<NBSP>create` with the two-byte NBSP split by the chunk
      // boundary. Decoding each chunk alone turns both halves into U+FFFD,
      // which is no separator, so the create was lost.
      const createWithNbsp = claudeBashToolUse('gh pr create --fill')
      const nbspAt = Buffer.from(createWithNbsp).indexOf(Buffer.from([0xc2, 0xa0]))
      const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(997) }) + '\n'
      // Place the NBSP's first byte at the last byte of the first chunk.
      const lead = CHUNK - 1 - nbspAt
      let head = filler.repeat(Math.floor((lead - 1) / filler.length))
      head += 'y'.repeat(lead - head.length - 1) + '\n'
      const content = head + createWithNbsp + '\n' + claudeToolResult('https://github.com/a/b/pull/7') + '\n'
      const bytes = Buffer.from(content)
      expect(bytes[CHUNK - 1]).toBe(0xc2)
      expect(bytes[CHUNK]).toBe(0xa0)

      const logPath = path.join(tempRoot, 'nbsp.jsonl')
      await fs.writeFile(logPath, bytes)
      expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([7])
      // The whole-content parser finds it too, so the chunked read must agree.
      expect(extractPullRequests(content).map((p) => p.number)).toEqual([7])
    })

    test('finds a create in a line that grows across incremental reads', async () => {
      // The partial line is carried across polls in small appends, with
      // `create` split over three of them.
      const logPath = path.join(tempRoot, 'grow.jsonl')
      const createLine = claudeBashToolUse('gh pr create --fill')
      const word = createLine.indexOf('create')
      const cuts = [word + 2, word + 3, word + 4]
      let from = 0
      await fs.writeFile(logPath, '')
      for (const cut of cuts) {
        await fs.appendFile(logPath, createLine.slice(from, cut))
        from = cut
        expect(getSessionPullRequests(logPath)).toEqual([])
      }
      await fs.appendFile(
        logPath,
        createLine.slice(from) + '\n' + claudeToolResult('https://github.com/a/b/pull/5') + '\n'
      )
      expect(getSessionPullRequests(logPath).map((p) => p.number)).toEqual([5])
    })

    test('ignores PR urls in chunks that have no create', async () => {
      const filler = 'see https://github.com/a/b/pull/1 for context '.repeat(5000)
      const logPath = path.join(tempRoot, 'nocreate.jsonl')
      await fs.writeFile(
        logPath,
        (claudeToolResult(filler) + '\n').repeat(3) + claudeToolResult('done')
      )
      expect(getSessionPullRequests(logPath)).toEqual([])
    })
  })
})
