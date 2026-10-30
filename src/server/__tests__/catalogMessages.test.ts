import { expect, test } from 'bun:test'
import { catalogMessage, sessionSummary } from '../catalogMessages'
import type { AgentSession, ServerMessage, Session } from '../../shared/types'

const mediaSummary = { identity: 'a', revision: '1', total: 2366, images: 2366, documents: 0, links: 0, additions: 2366 }
const media = Array.from({ length: 2366 }, (_, i) => ({ kind: 'image' as const, url: `/media/${i}`, label: 'x'.repeat(512) }))
const session = { id: 'a', lastUserMessage: 'x'.repeat(8192), media, mediaSummary } as Session
const agent = { sessionId: 'a', lastUserMessage: 'x'.repeat(8192), media, mediaSummary } as AgentSession

test('every catalog/lifecycle envelope strips media details and bounds previews', () => {
  const messages: ServerMessage[] = [
    { type: 'sessions', sessions: [session] }, { type: 'session-update', session },
    { type: 'session-created', session }, { type: 'agent-sessions', active: [agent], hibernating: [agent], history: [agent] },
    { type: 'agent-sessions-active', active: [agent] }, { type: 'session-orphaned', session: agent },
    { type: 'session-activated', session: agent, window: '@0' },
    { type: 'session-wake-result', sessionId: 'a', ok: true, session },
    { type: 'session-hibernate-result', sessionId: 'a', ok: true, session: agent },
    { type: 'session-move-to-history-result', sessionId: 'a', ok: true, session: agent },
  ]
  for (const message of messages) {
    const payload = JSON.stringify(catalogMessage(message))
    expect(payload).not.toContain('"media":')
    expect(payload).toContain('"total":2366')
    expect(Buffer.byteLength(payload)).toBeLessThan(2000)
  }
  expect(session.media).toHaveLength(2366)
  expect(session.lastUserMessage).toHaveLength(8192)
})

test('summary payload size is independent of media count; terminal data is untouched', () => {
  expect(sessionSummary(session).lastUserMessage).toHaveLength(250)
  const light = sessionSummary({ ...session, media: [] })
  expect(JSON.stringify(light)).toEqual(JSON.stringify(sessionSummary(session)))
  const terminal: ServerMessage = { type: 'terminal-output', sessionId: 'a', data: '{"media":"literal terminal text"}' }
  expect(catalogMessage(terminal)).toBe(terminal)
})
