import { describe, expect, test } from 'bun:test'
import { extractOutputReferences, loopbackUrl } from '../outputReferences'
import { extractSessionMedia } from '../mediaExtractor'

const claude = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const codex = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })

describe('presented output references', () => {
  test('extracts labeled HTML, paths with spaces and live URLs from both agents', () => {
    for (const record of [claude, codex]) {
      expect(extractOutputReferences(record('[Report](</tmp/my report.html>) and `work/preview.html`. Open http://localhost:3000/settings.'))).toEqual([
        { kind: 'html', target: '/tmp/my report.html', label: 'Report' },
        { kind: 'html', target: 'work/preview.html', label: 'preview.html' },
        { kind: 'localhost', target: 'http://localhost:3000/settings', label: 'App preview · port 3000' },
      ])
    }
  })
  test('does not promote user text, tool inputs/results, examples, or remote html links', () => {
    expect(extractOutputReferences({ type: 'user', message: { role: 'user', content: '/tmp/private.html' } })).toEqual([])
    expect(extractOutputReferences({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/index.html' } }] } })).toEqual([])
    expect(extractOutputReferences(claude('```html\n/tmp/index.html\n```\n[Site](https://example.com/index.html)'))).toEqual([])
  })
  test('event_msg and response_item copies dedupe in the incremental media pipeline', () => {
    const text = '[Report](/tmp/report.html) http://127.0.0.1:4141/'
    const log = [codex(text), { type: 'event_msg', payload: { type: 'agent_message', message: text } }].map(record => JSON.stringify(record)).join('\n')
    expect(extractSessionMedia(log).map(m => m.kind)).toEqual(['html', 'localhost'])
  })
  test('accepts only explicit loopback HTTP ports, no credentials or off-host targets', () => {
    for (const value of ['http://127.0.0.1.evil.test:3000', 'http://localhost', 'file:///tmp/a.html', 'http://me:pass@localhost:3000', 'http://192.168.1.1:3000']) expect(loopbackUrl(value)).toBeNull()
    expect(loopbackUrl('http://[::1]:3000/')?.port).toBe('3000')
  })
})

test('Codex visualize markers retain their type and title without promoting developer instructions', () => {
  const text = 'visualize{"path":"/tmp/sidebar-peek.html","title":"Sidebar peek","mode":"wide"}'
  expect(extractOutputReferences(codex(text))).toEqual([{ kind: 'visualization', target: '/tmp/sidebar-peek.html', label: 'Sidebar peek' }])
  expect(extractSessionMedia(JSON.stringify(codex(text)))[0].kind).toBe('visualization')
  expect(extractOutputReferences({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] } })).toEqual([])
  expect(extractOutputReferences(codex('visualizeinvalid'))).toEqual([])
})
