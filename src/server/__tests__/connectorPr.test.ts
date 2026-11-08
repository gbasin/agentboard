import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getCachedPullRequests, pullRequestScanPlan, rescanPullRequests } from '../agentSessions'
import type { AgentSessionRecord } from '../db'
import { GhRequestQueue } from '../ghRequestQueue'
import { clearPrScanCache, extractPullRequests, getSessionPullRequests } from '../prExtractor'
import { fetchPrInfo } from '../prInfo'

// Minimal synthetic versions of Codex response_item records: no private
// transcript, PR body, branch name, or tool IDs from the reported session.
const tool = 'mcp__codex_apps__github_create_pull_request'
const url = 'https://github.com/acme/widgets/pull/488'
const expected = [{ url, repo: 'acme/widgets', number: 488 }]
const invocation = `await tools.${tool}({repository_full_name:"acme/widgets",title:"fix",head:"fix",base:"main",body:"",draft:false})`
const record = (payload: unknown) => JSON.stringify({ type: 'response_item', payload })
const call = (input = `const r = ${invocation}; text(r);`, id = 'create') =>
  record({ type: 'custom_tool_call', name: 'exec', call_id: id, input })
const mcp = (overrides = {}) => ({
  content: [{ type: 'text', text: 'Action completed.' }],
  structuredContent: { url, number: 488, state: 'open', merged: false, draft: false },
  isError: false,
  ...overrides,
})
const result = (output: unknown = mcp(), id = 'create') => record({
  type: 'custom_tool_call_output', call_id: id,
  output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify(output) }],
})
const merge = [
  call('const r = await tools.mcp__codex_apps__github_merge_pull_request({pull_number:488}); text(r)', 'merge'),
  result({ structuredContent: { merged: true, message: 'Pull Request successfully merged' }, isError: false }, 'merge'),
]
let tempRoot: string
beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentboard-connector-pr-'))
  clearPrScanCache()
})
afterEach(async () => { await fs.rm(tempRoot, { recursive: true, force: true }) })

describe('connector PR association', () => {
  test('associates unified exec create output and ignores the later merge result', () => {
    expect(extractPullRequests([call(), result(), ...merge].join('\n'))).toEqual(expected)
  })

  test('supports direct Codex connector invocations and JSON-string results', () => {
    const direct = record({ type: 'function_call', name: tool, call_id: 'direct', arguments: '{}' })
    const output = record({ type: 'function_call_output', call_id: 'direct', output: JSON.stringify(mcp()) })
    expect(extractPullRequests(`${direct}\n${output}`)).toEqual(expected)
    const custom = record({ type: 'custom_tool_call', name: tool, call_id: 'direct', input: '{}' })
    expect(extractPullRequests(`${custom}\n${output}`)).toEqual(expected)
  })

  test('supports direct Claude MCP calls with structured result content', () => {
    const direct = JSON.stringify({ message: { content: [{ type: 'tool_use', name: tool, id: 'direct', input: {} }] } })
    const output = JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'direct', content: mcp() }] } })
    expect(extractPullRequests(`${direct}\n${output}`)).toEqual(expected)
  })

  test('matches exact result IDs, even when an unrelated output mentions the pending ID', () => {
    expect(extractPullRequests([call(), result({ ...mcp(), text: 'create' }, 'create-other')].join('\n'))).toEqual([])
    expect(extractPullRequests([call(), result(mcp(), 'create-other'), '{}', result()].join('\n'))).toEqual(expected)
  })

  test('rejects failed and malformed results instead of mining their URLs', () => {
    for (const output of [
      mcp({ isError: true }), mcp({ error: 'failed' }),
      { content: [{ type: 'text', text: url }] }, { url, number: 488 },
      mcp({ structuredContent: { url, number: 489 } }),
      mcp({ structuredContent: { url: url + '/files', number: 488 } }),
      mcp({ structuredContent: { url, number: 488, error: 'failed' } }),
    ]) expect(extractPullRequests(`${call()}\n${result(output)}`)).toEqual([])
    // A failed result closes the pending call; later reuse cannot revive it.
    expect(extractPullRequests([call(), result(mcp({ isError: true })), result()].join('\n'))).toEqual([])
  })

  test('rejects search, read, review, merge, and mixed-operation exec output', () => {
    for (const operation of ['search_pull_requests', 'get_pull_request', 'review_pull_request', 'merge_pull_request']) {
      const other = invocation.replace('create_pull_request', operation)
      expect(extractPullRequests(`${call(`text(${other});`)}\n${result()}`)).toEqual([])
      const direct = record({ type: 'function_call', name: tool.replace('create_pull_request', operation), call_id: 'create', arguments: '{}' })
      expect(extractPullRequests(`${direct}\n${result()}`)).toEqual([])
    }
    const mixed = `${invocation}; await tools.mcp__codex_apps__github_get_pull_request({});`
    expect(extractPullRequests(`${call(mixed)}\n${result()}`)).toEqual([])
  })

  test('does not treat source strings, comments, regexes, templates, or stored callbacks as execution', () => {
    for (const input of [
      `text(${JSON.stringify(invocation)})`,
      `const source = '${invocation}'; text(source)`,
      `const source = \`${invocation}\`; text(source)`,
      `// ${invocation}\ntext('done')`, `/* ${invocation} */ text('done')`,
      `const pattern = /tools.${tool}\\(/; text(pattern)`,
      `const source = () => ${invocation}`, `async function example() { ${invocation} }`,
      `if (false) { ${invocation} }`,
      `false && ${invocation}`, `false ? ${invocation} : null`, `const example = { async method() { ${invocation} } };`,
      `{} /await tools.${tool}({})/;`,
      `const template = \`example \${'${invocation}'}\`;`,
    ]) expect(extractPullRequests(`${call(input)}\n${result()}`)).toEqual([])
    expect(extractPullRequests(`${JSON.stringify({ message: { content: [{ type: 'text', text: invocation }] } })}\n${result()}`)).toEqual([])
  })

  test('handles comments between executable member tokens', () => {
    expect(extractPullRequests(`${call(`text(await tools /* API */ . ${tool}({}));`)}\n${result()}`)).toEqual(expected)
  })

  test('ignores null result blocks without dropping a later valid MCP result', () => {
    const output = record({ type: 'custom_tool_call_output', call_id: 'create', output: [
      null, { type: 'input_text', text: JSON.stringify(mcp()) }, null,
    ] })
    expect(extractPullRequests(`${call()}\n${output}`)).toEqual(expected)
  })

  test('retains a pending create across delayed results', () => {
    expect(extractPullRequests([call(), ...Array(100).fill('{}'), result()].join('\n'))).toEqual(expected)
  })

  test('incremental scanner handles every connector-name split and delayed result chunks', async () => {
    const content = call()
    const start = content.indexOf('github_create_pull_request')
    for (let split = 1; split < 'github_create_pull_request'.length; split++) {
      const file = path.join(tempRoot, `split-${split}.jsonl`)
      await fs.writeFile(file, content.slice(0, start + split))
      expect(getSessionPullRequests(file)).toEqual([])
      await fs.appendFile(file, content.slice(start + split) + '\n' + JSON.stringify({ text: 'x'.repeat(140 * 1024) }) + '\n')
      expect(getSessionPullRequests(file)).toEqual([])
      const output = result()
      await fs.appendFile(file, output.slice(0, 50))
      expect(getSessionPullRequests(file)).toEqual([])
      await fs.appendFile(file, output.slice(50) + '\n' + merge.join('\n') + '\n')
      expect(getSessionPullRequests(file)).toEqual(expected)
    }
  })

  test('byte prefilter finds a connector-only create beyond a read-chunk boundary', async () => {
    const file = path.join(tempRoot, 'chunks.jsonl')
    const line = call()
    const at = line.indexOf('github_create_pull_request')
    // Pad the same line, so the tool name crosses the 128 KiB read boundary.
    const padding = ' '.repeat(128 * 1024 - at - 7)
    await fs.writeFile(file, `${padding}${line}\n${result()}\n`)
    expect(getSessionPullRequests(file)).toEqual(expected)
  })

  test('metadata scan associates the PR and existing GitHub lookup reports MERGED', async () => {
    const file = path.join(tempRoot, 'metadata.jsonl')
    await fs.writeFile(file, [call(), result(), ...merge, ''].join('\n'))
    const session: AgentSessionRecord = {
      id: 488, sessionId: 'connector-integration', logFilePath: file,
      projectPath: tempRoot, slug: null, agentType: 'codex', displayName: 'test',
      createdAt: '2026-01-01T00:00:00Z', lastActivityAt: '2026-01-01T00:00:00Z',
      lastUserMessage: null, currentWindow: null, isHibernating: false,
      lastResumeError: null, wakeStartedAt: null,
      lastKnownLogSize: (await fs.stat(file)).size, isCodexExec: false, launchCommand: null,
    }
    const github = spyOn(GhRequestQueue.prototype, 'request').mockResolvedValue({
      state: 'MERGED', isDraft: false, title: 'fix', author: { login: 'author' },
    })
    try {
      // This is the same scan/serialization path used by sessionMetadataWorker.
      expect(rescanPullRequests(session, pullRequestScanPlan(session))).toBe(true)
      const prs = getCachedPullRequests(session)
      expect(prs).toEqual(expected)
      expect(await fetchPrInfo(prs.map((pr) => pr.url))).toEqual([
        { url, state: 'MERGED', isDraft: false, title: 'fix', author: 'author' },
      ])
      expect(github).toHaveBeenCalledWith('acme/widgets', 488, 'state,isDraft,title,author')
    } finally { github.mockRestore() }
  })
})
