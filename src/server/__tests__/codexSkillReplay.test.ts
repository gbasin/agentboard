// Native text+skill rollout shape observed with installed Codex 0.166.0 on
// 2026-11-02; fixture replaces temporary paths and ids, keeping user blocks.
// @reads: src/server/__tests__/fixtures/codex/skill-invocation.jsonl
import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { parseCodexRollout, replayCodexRolloutAsync } from '../chat/codex/codexRollout'

// Table W5 verbatim: [Id, Input / seam, Observable result].
const oracle = ['W5', 'Codex rollout with text plus explicit skill input, replay and reconnect', 'Human text appears once unchanged, no skill-file content or metadata user row']

// @covers: codex-chat-sessions › Human slash-skill references invoke explicit Codex skills › Peer mail and history
test('W5/S3: native skill rollout replays the submitted text once without injected skill content', async () => {
  expect(oracle[0]).toBe('W5')
  const file = path.join(import.meta.dir, 'fixtures/codex/skill-invocation.jsonl')
  const content = fs.readFileSync(file, 'utf8')
  const events = parseCodexRollout(content)
  expect(events.filter(event => event.type === 'user_message').map(event => event.text)).toEqual([
    '/autocomplete-smoke Please follow the attached skill.',
  ])
  expect(events.map(event => event.type)).toEqual(['turn_started', 'user_message', 'assistant_text', 'turn_completed'])
  expect(events.find(event => event.type === 'assistant_text')).toMatchObject({ text: 'AUTOCOMPLETE_SMOKE_OK' })
  expect((await replayCodexRolloutAsync(file)).events).toEqual(events)
  expect(parseCodexRollout(content)).toEqual(events)
})
