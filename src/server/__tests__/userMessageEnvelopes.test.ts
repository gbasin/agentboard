import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractLastUserMessageFromLog, isToolNotificationText } from '../logMatcher'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const schemas = {
  claude: (text: string) => ({ type: 'user', message: { role: 'user', content: text } }),
  codexResponse: (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  }),
  codexEvent: (text: string) => ({
    type: 'event_msg', payload: { type: 'user_message', message: text },
  }),
}

test('ignores Claude API snapshots that repackage image tool metadata as user text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-api-snapshot-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  const note = '[Image: original 1206x2622, displayed at 1185x2576. Multiply coordinates by 1.02 to map to original image.]'
  const entries = [
    schemas.claude('you can also run it on m1p if it’s free'),
    { ...schemas.claude(note), isMeta: true, turnCompanion: true },
    { type: 'api-request-blob', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-image', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '' } }] },
      { type: 'text', text: note },
    ] } },
    { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'image' }] } },
  ]
  writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'))
  expect(extractLastUserMessageFromLog(file, { lineLimit: 0, byteLimit: 32768, maxByteLimit: 2097152 }))
    .toBe('you can also run it on m1p if it’s free')
})

for (const [schema, entry] of Object.entries(schemas)) {
  describe(schema, () => {
    function extract(text: string) {
      const dir = mkdtempSync(join(tmpdir(), 'ab-user-envelope-'))
      dirs.push(dir)
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, [entry('real prior prompt'), entry(text)].map((item) => JSON.stringify(item)).join('\n'))
      return extractLastUserMessageFromLog(file)
    }

    test('skips unflagged system reminders and tool-loading notices', () => {
      expect(extract('<system-reminder>Result of calling the Read tool: instructions</system-reminder>')).toBe('real prior prompt')
      expect(extract('Tool loaded.')).toBe('real prior prompt')
      expect(extract('<system-reminder>truncated reminder')).toBe('real prior prompt')
    })

    test('preserves user text around reminders', () => {
      expect(extract('<system-reminder>context</system-reminder>fix the parser')).toBe('fix the parser')
      expect(extract('fix the parser<system-reminder>context</system-reminder>')).toBe('fix the parser')
    })

    test('handles reminder IDs on both tags without discarding adjacent user text', () => {
      const reminder = '<system-reminder id="4506f64571faf1f5">Coordinator message</system-reminder id="4506f64571faf1f5">'
      expect(extract(reminder)).toBe('real prior prompt')
      expect(extract(`${reminder}fix the parser`)).toBe('fix the parser')
      expect(extract(`fix the parser${reminder}`)).toBe('fix the parser')
      expect(extract('<system-reminder id="4506f64571faf1f5">truncated')).toBe('real prior prompt')
    })

    test('extracts question answers without the transport envelope', () => {
      expect(extract('<send_user_message_question_reply>\n[{"answer":"use option B"},{"answer":"keep tests"}]\n</send_user_message_question_reply>')).toBe('use option B · keep tests')
    })

    test('skips malformed or empty question replies', () => {
      for (const body of ['broken JSON', '{}', '[]', '[{"answer":null}]', '[{"answer":" "}]']) {
        expect(extract(`<send_user_message_question_reply>${body}</send_user_message_question_reply>`)).toBe('real prior prompt')
      }
    })

    test('cleans image wrappers and labels while preserving the prompt', () => {
      expect(extract('<image name=[Image #1] path="/tmp/paste.png"></image>Fix this [Image #1]')).toBe('Fix this')
      expect(extract('<image name=[Image #1] path="/tmp/paste.png">')).toBe('Image attached')
      expect(extract('[Image #2]')).toBe('Image attached')
      expect(extract('Compare [Image #1] with [Image #2]')).toBe('Compare with')
    })

    test('skips continuation summaries', () => {
      expect(extract('This session is being continued from a previous conversation that ran out of context. Summary here')).toBe('real prior prompt')
    })

    test('preserves ordinary XML and prose about tools', () => {
      expect(extract('<example>hello</example>')).toBe('<example>hello</example>')
      expect(extract('Tool loaded. Now fix the parser.')).toBe('Tool loaded. Now fix the parser.')
    })
  })
}

test('cached, truncated envelopes trigger re-extraction', () => {
  for (const text of [
    '<system-reminder>Result of calling the Read tool: ' + 'x'.repeat(300),
    '<send_user_message_question_reply>\n[{"answer":"' + 'x'.repeat(300),
    '<system-reminder id="4506f64571faf1f5">' + 'x'.repeat(300),
    '<system-reminder id="unfinished',
    'Tool loaded.',
    'This session is being continued from a previous conversation that ran out of context. Summary',
    '<image name=[Image #1] path="' + 'x'.repeat(300),
    '[Image #2]',
  ]) {
    expect(isToolNotificationText(text.slice(0, 250))).toBe(true)
  }
})

test('joins text blocks before choosing the last prompt and skips flagged summaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-user-blocks-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  const entries = [
    { type: 'user', message: { role: 'user', content: [
      { type: 'text', text: '[Image #1]' },
      { type: 'image', source: { type: 'base64', data: 'ignored' } },
      { type: 'text', text: 'Fix the layout' },
      { type: 'text', text: 'Keep the colors' },
    ] } },
    { ...schemas.claude('A differently worded summary'), isCompactSummary: true },
  ]
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n'))
  expect(extractLastUserMessageFromLog(file)).toBe('Fix the layout Keep the colors')
})

test('recognizes structured image-only messages without requiring a text label', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-user-images-'))
  dirs.push(dir)
  const file = join(dir, 'session.jsonl')
  for (const entry of [
    { type: 'user', message: { role: 'user', content: [{ type: 'image' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '', images: ['image'] } },
    { type: 'event_msg', payload: { type: 'user_message', message: '', local_images: ['/tmp/image.png'] } },
  ]) {
    writeFileSync(file, JSON.stringify(entry))
    expect(extractLastUserMessageFromLog(file)).toBe('Image attached')
    writeFileSync(file, JSON.stringify({ ...entry, isMeta: true }))
    expect(extractLastUserMessageFromLog(file)).toBeNull()
  }
})
