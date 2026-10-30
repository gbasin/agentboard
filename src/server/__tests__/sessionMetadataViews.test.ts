import { afterEach, expect, test } from 'bun:test'
import { SessionRegistry } from '../SessionRegistry'
import { SessionMetadataPublisher } from '../sessionMetadataViews'
import type { AgentSessionRecord } from '../db'
import type { AgentSession, Session } from '../../shared/types'
import type { SessionMetadata } from '../sessionMetadataWorker'

const publishers: SessionMetadataPublisher[] = []
afterEach(() => { for (const publisher of publishers.splice(0)) publisher.dispose() })
const record = (id: number, log = `/log/${id}`) => ({ sessionId: `session-${id}`, logFilePath: log, agentType: 'claude' } as AgentSessionRecord)
const row = (id: number, fields: Partial<AgentSession> = {}) => ({ ...record(id), host: 'local', displayName: `Current ${id}`, lastActivityAt: '', ...fields } as AgentSession)
const metadata = (number: number): SessionMetadata => ({ prs: [{ url: `https://github.com/test/repo/pull/${number}`, repo: 'test/repo', number }] })
function fixture(rows: AgentSession[]) {
  const registry = new SessionRegistry()
  registry.setAgentSessions([], [], rows)
  const events: unknown[] = []
  registry.on('agent-sessions', value => events.push(value))
  const publisher = new SessionMetadataPublisher(registry, 'local'); publishers.push(publisher)
  return { registry, events, publisher }
}

test('many dormant hydration updates produce one catalog event with latest per-session metadata', async () => {
  const { registry, events, publisher } = fixture(Array.from({ length: 1000 }, (_, i) => row(i)))
  for (let i = 0; i < 1000; i++) publisher.queue(record(i), metadata(1))
  publisher.queue(record(3), metadata(2))
  await Bun.sleep(100)
  expect(events).toHaveLength(0)
  await Bun.sleep(200)
  expect(events).toHaveLength(1)
  const history = registry.getAgentSessions().history
  expect(history.every(value => value.prs?.length === 1)).toBe(true)
  expect(history[3].prs?.[0].number).toBe(2)
  publisher.queue(record(3), metadata(3))
  await Bun.sleep(100)
  expect(events).toHaveLength(1)
  await Bun.sleep(200)
  expect(events).toHaveLength(2)
})

test('flush revalidates current identity and host and preserves lifecycle/name changes', async () => {
  const { registry, events, publisher } = fixture([row(1), row(2), row(3), row(4)])
  for (let i = 1; i <= 4; i++) publisher.queue(record(i), metadata(i))
  // Change membership and identity after queueing, before publication.
  registry.setAgentSessions([], [row(1, { displayName: 'Renamed while queued', isHibernating: true })], [
    row(2, { logFilePath: '/replacement' }), row(3, { host: 'remote' }),
  ])
  events.length = 0
  await Bun.sleep(300)
  expect(events).toHaveLength(1)
  const current = registry.getAgentSessions()
  expect(current.active).toEqual([])
  expect(current.hibernating[0]).toMatchObject({ displayName: 'Renamed while queued', isHibernating: true, prs: metadata(1).prs })
  expect(current.history.map(value => value.prs)).toEqual([undefined, undefined])
  expect(current.history.some(value => value.sessionId === 'session-4')).toBe(false)
})

test('queue retains at most 5000 associations and disposal cancels pending publication', async () => {
  const { registry, events, publisher } = fixture([row(0), row(5000)])
  for (let i = 0; i <= 5000; i++) publisher.queue(record(i), metadata(i + 1))
  await Bun.sleep(300)
  expect(events).toHaveLength(1)
  expect(registry.getAgentSessions().history[0].prs).toBeUndefined()
  expect(registry.getAgentSessions().history[1].prs?.[0].number).toBe(5001)
  publisher.queue(record(0), metadata(9))
  publisher.dispose()
  publisher.queue(record(0), metadata(10))
  await Bun.sleep(300)
  expect(events).toHaveLength(1)
})


test('live patches target only the current local association and retain current terminal state', async () => {
  const { registry, publisher } = fixture([])
  const live = { id: 'terminal', agentSessionId: 'session-1', logFilePath: '/log/1', agentType: 'claude',
    name: 'Original', status: 'working', lastActivity: '', createdAt: '' } as Session
  registry.replaceSessions([live, { ...live, id: 'remote', remote: true }])
  publisher.queue(record(1), metadata(8))
  registry.updateSession('terminal', { name: 'Renamed', status: 'waiting' })
  await Bun.sleep(300)
  expect(registry.get('terminal')).toMatchObject({ name: 'Renamed', status: 'waiting', prs: metadata(8).prs })
  expect(registry.get('remote')?.prs).toBeUndefined()
  publisher.queue(record(1), metadata(9))
  registry.updateSession('terminal', { logFilePath: '/reassociated', prs: [] })
  await Bun.sleep(300)
  expect(registry.get('terminal')?.prs).toEqual([])
})
