import { expect, test } from 'bun:test'
import { OwnershipObserver } from '../ownership/observer'
import type { Observation, OwnershipWindow } from '../ownership/probe'

function fixture() {
  const windows: OwnershipWindow[] = [{ tmuxWindow: 'ab:@1', agentType: 'claude', agentSessionId: 'one' }]
  const result: Observation = { window: 'ab:@1', pane: '%1', agent: 'claude', status: 'resolved', pid: 10, started: 'start', sessionId: 'one' }
  const events: { event: string; data: Record<string, unknown> }[] = []
  const dependencies = { windows: () => windows, probe: async (): Promise<Observation[]> => [result],
    log: (event: string, data: Record<string, unknown>) => { events.push({ event, data }) } }
  return { windows, result, events, dependencies, observer: new OwnershipObserver(dependencies) }
}

test('observer compares without mutating input and logs changes only', async () => {
  const f = fixture(); const initial = structuredClone(f.windows)
  await f.observer.observe(); await f.observer.observe()
  expect(f.events.filter(event => event.event === 'ownership_observation')).toHaveLength(1)
  expect(f.events[0].data.comparison).toBe('agree')
  expect(f.windows).toEqual(initial)
  delete f.windows[0].agentSessionId
  await f.observer.observe()
  expect(f.events.filter(event => event.event === 'ownership_observation').at(-1)?.data.comparison).toBe('unmatched')
  f.windows[0].agentSessionId = 'other'
  await f.observer.observe()
  expect(f.events.filter(event => event.event === 'ownership_observation').at(-1)?.data.comparison).toBe('disagree')
})

test('overlapping requests are coalesced and stop suppresses late output', async () => {
  const f = fixture(); let finish!: (value: Observation[]) => void; let calls = 0
  f.dependencies.probe = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  const pending = f.observer.observe()
  await f.observer.observe()
  expect(calls).toBe(1)
  f.observer.stop(); finish([f.result]); await pending
  expect(f.events).toEqual([])
})

test('late result is discarded when current matching changed', async () => {
  const f = fixture()
  f.dependencies.probe = async () => { f.windows[0] = { ...f.windows[0], agentSessionId: 'two' }; return [f.result] }
  await f.observer.observe()
  expect(f.events).toHaveLength(1)
  expect(f.events[0].data.discarded).toBe(1)
})

test('inspection failure never becomes an unmatched result; repeated failures are deduplicated', async () => {
  const f = fixture()
  f.dependencies.probe = async () => { throw new Error('timeout') }
  await f.observer.observe(); await f.observer.observe()
  expect(f.events).toEqual([{ event: 'ownership_observation_error', data: { message: 'timeout' } }])
  expect(f.windows[0].agentSessionId).toBe('one')
})

test('in-place registry updates cannot change the initial comparison snapshot', async () => {
  const f = fixture()
  f.dependencies.probe = async () => { f.windows[0].agentSessionId = 'two'; return [f.result] }
  await f.observer.observe()
  expect(f.events[0].data.discarded).toBe(1)
})

test('start is idempotent and performs an initial observation', async () => {
  const f = fixture(); let calls = 0
  f.dependencies.probe = async () => { calls++; return [f.result] }
  try {
    f.observer.start(); f.observer.start()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls).toBe(1)
    expect(f.events[0].data.comparison).toBe('agree')
  } finally { f.observer.stop() }
})
