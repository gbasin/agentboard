import { describe, expect, test } from 'bun:test'
import { extractReplyLinks } from '../replyLinks'
import { extractMediaItems, extractSessionMedia } from '../mediaExtractor'

const url = 'https://example.com/report?version=2#summary'
const text = `Finished: [Review report](${url}).`

describe('visible assistant reply URLs', () => {
  test.each([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: text } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'message', source: 'devin', message: { role: 'assistant', content: text, toolCalls: [] } },
    { type: 'assistant', content: text, model_fingerprint: 'grok' },
  ])('supported agent format %#', record => {
    expect(extractReplyLinks(record)).toEqual([{ kind: 'link', url, label: 'Review report', sourceText: text }])
  })

  test.each([
    { type: 'user', message: { role: 'user', content: text } },
    { type: 'assistant', isMeta: true, message: { role: 'assistant', content: text } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'search', input: { url } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: text }] } },
    { type: 'response_item', payload: { type: 'function_call_output', output: text } },
    { role: 'tool', content: text },
    { type: 'assistant', content: '[Report](file:///tmp/a.html) /tmp/report.html javascript:alert(1) sandbox:/mnt/data/a.html' },
  ])('excludes non-replies and non-web destinations %#', record => {
    expect(extractReplyLinks(record)).toEqual([])
  })

  test('bare URLs, autolinks, balanced parentheses, repeated URLs and exact query/fragment', () => {
    const content = `See <${url}> and ${url}. Or [Wiki](https://en.wikipedia.org/wiki/Function_(mathematics)). http://localhost:4197/preview; https://example.com/report?version=3#summary`
    const links = extractReplyLinks({ type: 'assistant', content })
    expect(links.map(l => l.url)).toEqual([url, 'https://en.wikipedia.org/wiki/Function_(mathematics)', 'http://localhost:4197/preview', 'https://example.com/report?version=3#summary'])
    expect(links[1].label).toBe('Wiki')
  })

  test('keeps image indices stable and deduplicates Codex mirrored reply records', () => {
    const image = { type: 'image', source: { data: 'aGk=', media_type: 'image/png' } }
    const record = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, image] } }
    expect(extractMediaItems(JSON.stringify(record)).map(m => m.kind)).toEqual(['image', 'link'])
    const events = [
      { type: 'event_msg', payload: { type: 'agent_message', message: text } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    ]
    expect(extractSessionMedia(events.map(e => JSON.stringify(e)).join('\n'))).toHaveLength(1)
  })

  test('bounded source text and HTML remains inert text', () => {
    const content = 'x'.repeat(2000) + ` ${url} <img src=x onerror=alert(1)> ` + 'z'.repeat(2000)
    const result = extractReplyLinks({ type: 'assistant', content })[0]
    expect(result.sourceText.length).toBeLessThanOrEqual(1202)
    expect(result.sourceText).toContain('<img src=x onerror=alert(1)>')
    expect(result.sourceText).toStartWith('…')
    expect(result.sourceText).toEndWith('…')
  })
})

test('Markdown destinations, reference links, formatted labels, escapes, and entities are parsed correctly', () => {
  const content = '[https://label.example](https://target.example/a?x=1&y=2)\n' +
    '[Review **report**][report]\n\n[report]: https://example.com/a_(b)?v=2#result "Report"\n' +
    '[Escaped](https://example.com/a\\(b\\)) [Exact](https://example.com/yes!)'
  const result = extractReplyLinks({ type: 'assistant', content })
  expect(result.map(l => l.url)).toEqual(['https://target.example/a?x=1&y=2', 'https://example.com/a_(b)?v=2#result', 'https://example.com/a(b)', 'https://example.com/yes!'])
  expect(result[0].label).toBe('https://label.example')
  expect(result[1].label).toBe('Review report')
})
