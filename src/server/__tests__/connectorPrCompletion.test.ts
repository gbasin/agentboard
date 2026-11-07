import { afterAll, afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { connectorPrCompletion, connectorPrUrl } from '../../../tests/fixtures/connectorPr'
import { clearPrScanCache, extractPullRequests, getSessionPullRequests } from '../prExtractor'

const expected = [{ url: connectorPrUrl, repo: 'gbasin/agentboard', number: 522 }]
const line = (item = {}) => JSON.stringify(connectorPrCompletion(item))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-mcp-completion-'))
afterEach(() => { clearPrScanCache(); for (const file of fs.readdirSync(root)) fs.unlinkSync(path.join(root, file)) })
afterAll(() => fs.rmdirSync(root))

test('accepts self-contained completion from mixed exec and deduplicates repeated events', () => {
  const call = JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'create',
    input: 'text(await tools.mcp__codex_apps__github_create_pull_request({})); text(await tools.exec_command({cmd:"pwd"}));' } })
  expect(extractPullRequests(call)).toEqual([])
  expect(extractPullRequests([call, line(), line()].join('\n'))).toEqual(expected)
  expect(extractPullRequests(line())).toEqual(expected)
})

test('rejects failed, unrelated, malformed, and nested example completions', () => {
  for (const item of [
    { status: 'failed' }, { status: 'in_progress' }, { status: undefined },
    { server: 'other' }, { tool: 'github.get_pull_request' }, { tool: 'github.update_pull_request' },
    { type: 'CommandExecution' }, { result: null },
    { result: { isError: true, structuredContent: { url: connectorPrUrl, number: 522 } } },
    { result: { structuredContent: { url: connectorPrUrl, number: 523 } } },
    { result: { content: [{ type: 'text', text: connectorPrUrl }] } },
    { result: { structuredContent: { url: connectorPrUrl + '/files', number: 522 } } },
  ]) expect(extractPullRequests(line(item))).toEqual([])
  const event = connectorPrCompletion()
  for (const entry of [
    { ...event, type: 'response_item' },
    { ...event, payload: { ...event.payload, type: 'item_started' } },
    { type: 'response_item', payload: { type: 'message', content: line() } },
  ]) expect(extractPullRequests(JSON.stringify(entry))).toEqual([])
})

test('incremental scanner accepts every dotted tool-name split and delayed newline', () => {
  const content = line(), name = 'github.create_pull_request', at = content.indexOf(name)
  for (let split = 1; split < name.length; split++) {
    const file = path.join(root, `${split}.jsonl`)
    fs.writeFileSync(file, content.slice(0, at + split))
    expect(getSessionPullRequests(file)).toEqual([])
    fs.appendFileSync(file, content.slice(at + split))
    expect(getSessionPullRequests(file)).toEqual([])
    fs.appendFileSync(file, '\n')
    expect(getSessionPullRequests(file)).toEqual(expected)
    expect(getSessionPullRequests(file)).toEqual(expected)
  }
})

test('cold scanner recognizes dotted completion across each 128KiB chunk seam', () => {
  const content = line(), name = 'github.create_pull_request', at = content.indexOf(name)
  for (let split = 1; split < name.length; split++) {
    const file = path.join(root, `chunk-${split}.jsonl`)
    fs.writeFileSync(file, ' '.repeat(128 * 1024 - at - split) + content + '\n')
    expect(getSessionPullRequests(file)).toEqual(expected)
  }
})


test('deduplicates the same PR from a recognized wrapper result and completion', () => {
  const result = connectorPrCompletion().payload.item.result
  const call = { type: 'response_item', payload: { type: 'function_call',
    name: 'mcp__codex_apps__github_create_pull_request', call_id: 'direct', arguments: '{}' } }
  const output = { type: 'response_item', payload: { type: 'function_call_output',
    call_id: 'direct', output: JSON.stringify(result) } }
  for (const entries of [[call, output, connectorPrCompletion()], [call, connectorPrCompletion(), output]]) {
    expect(extractPullRequests(entries.map(entry => JSON.stringify(entry)).join('\n'))).toEqual(expected)
  }
})
